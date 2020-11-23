import * as _ from "lodash";
import * as path from "path";
import * as express from "express";
import * as clc from "cli-color";
import * as http from "http";
import * as jwt from "jsonwebtoken";

import * as api from "../api";
import * as logger from "../logger";
import * as track from "../track";
import { Constants } from "./constants";
import {
  EmulatorInfo,
  EmulatorInstance,
  EmulatorLog,
  Emulators,
  FunctionsExecutionMode,
} from "./types";
import * as chokidar from "chokidar";

import * as spawn from "cross-spawn";
import { ChildProcess, spawnSync } from "child_process";
import {
  EmulatedTriggerDefinition,
  EmulatedTriggerType,
  FunctionsRuntimeArgs,
  FunctionsRuntimeBundle,
  FunctionsRuntimeFeatures,
  getFunctionRegion,
  getFunctionService,
  HttpConstants,
} from "./functionsEmulatorShared";
import { EmulatorRegistry } from "./registry";
import { EventEmitter } from "events";
import * as stream from "stream";
import { EmulatorLogger, Verbosity } from "./emulatorLogger";
import { RuntimeWorker, RuntimeWorkerPool } from "./functionsRuntimeWorker";
import { PubsubEmulator } from "./pubsubEmulator";
import { FirebaseError } from "../error";
import { WorkQueue } from "./workQueue";
import { createDestroyer } from "../utils";
import { getCredentialPathAsync } from "../defaultCredentials";

const EVENT_INVOKE = "functions:invoke";

/*
 * The Realtime Database emulator expects the `path` field in its trigger
 * definition to be relative to the database root. This regex is used to extract
 * that path from the `resource` member in the trigger definition used by the
 * functions emulator.
 *
 * Groups:
 *   1 - instance
 *   2 - path
 */
const DATABASE_PATH_PATTERN = new RegExp("^projects/[^/]+/instances/([^/]+)/refs(/.*)$");

export interface FunctionsEmulatorArgs {
  projectId: string;
  functionsDir: string;
  port?: number;
  host?: string;
  quiet?: boolean;
  disabledRuntimeFeatures?: FunctionsRuntimeFeatures;
  debugPort?: number;
  env?: { [key: string]: string };
  remoteEmulators?: { [key: string]: EmulatorInfo };
  predefinedTriggers?: EmulatedTriggerDefinition[];
  nodeMajorVersion?: number; // Lets us specify the node version when emulating extensions.
}

// FunctionsRuntimeInstance is the handler for a running function invocation
export interface FunctionsRuntimeInstance {
  // Process ID
  pid: number;
  // An emitter which sends our EmulatorLog events from the runtime.
  events: EventEmitter;
  // A promise which is fulfilled when the runtime has exited
  exit: Promise<number>;

  // A function to manually kill the child process as normal cleanup
  shutdown(): void;
  // A function to manually kill the child process in case of errors
  kill(signal?: string): void;
  // Send an IPC message to the child process
  send(args: FunctionsRuntimeArgs): boolean;
}

export interface InvokeRuntimeOpts {
  nodeBinary: string;
  serializedTriggers?: string;
  extensionTriggers?: EmulatedTriggerDefinition[];
  env?: { [key: string]: string };
  ignore_warnings?: boolean;
}

interface RequestWithRawBody extends express.Request {
  rawBody: Buffer;
}

interface TriggerDescription {
  name: string;
  entryPoint: string;
  type: string;
  labels?: { [key: string]: any };
  details?: string;
  ignored?: boolean;
}

interface EmulatedTriggerRecord {
  def: EmulatedTriggerDefinition;
  enabled: boolean;
}

export class FunctionsEmulator implements EmulatorInstance {
  static getHttpFunctionUrl(
    host: string,
    port: number,
    projectId: string,
    name: string,
    region: string
  ): string {
    return `http://${host}:${port}/${projectId}/${region}/${name}`;
  }

  nodeBinary = "";
  private destroyServer?: () => Promise<void>;
  private triggers: { [triggerName: string]: EmulatedTriggerRecord } = {};
  private triggerGeneration = 1;

  private workerPool: RuntimeWorkerPool;
  private workQueue: WorkQueue;
  private logger = EmulatorLogger.forEmulator(Emulators.FUNCTIONS);

  private multicastTriggers: { [s: string]: string[] } = {};

  constructor(private args: FunctionsEmulatorArgs) {
    // TODO: Would prefer not to have static state but here we are!
    EmulatorLogger.verbosity = this.args.quiet ? Verbosity.QUIET : Verbosity.DEBUG;
    // When debugging is enabled, the "timeout" feature needs to be disabled so that
    // functions don't timeout while a breakpoint is active.
    if (this.args.debugPort) {
      this.args.disabledRuntimeFeatures = this.args.disabledRuntimeFeatures || {};
      this.args.disabledRuntimeFeatures.timeout = true;
    }

    const mode = this.args.debugPort
      ? FunctionsExecutionMode.SEQUENTIAL
      : FunctionsExecutionMode.AUTO;
    this.workerPool = new RuntimeWorkerPool(mode);
    this.workQueue = new WorkQueue(mode);
  }

  private async getCredentialsEnvironment(): Promise<Record<string, string>> {
    // Provide default application credentials when appropriate
    const credentialEnv: Record<string, string> = {};
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      this.logger.logLabeled(
        "WARN",
        "functions",
        `Your GOOGLE_APPLICATION_CREDENTIALS environment variable points to ${process.env.GOOGLE_APPLICATION_CREDENTIALS}. Non-emulated services will access production using these credentials. Be careful!`
      );
    } else {
      const defaultCredPath = await getCredentialPathAsync();
      if (defaultCredPath) {
        this.logger.log("DEBUG", `Setting GAC to ${defaultCredPath}`);
        credentialEnv.GOOGLE_APPLICATION_CREDENTIALS = defaultCredPath;
      } else {
        // TODO: It would be safer to set GOOGLE_APPLICATION_CREDENTIALS to /dev/null here but we can't because some SDKs don't work
        //       without credentials even when talking to the emulator: https://github.com/firebase/firebase-js-sdk/issues/3144
        this.logger.logLabeled(
          "WARN",
          "functions",
          "You are not signed in to the Firebase CLI. If you have authorized this machine using gcloud application-default credentials those may be discovered and used to access production services."
        );
      }
    }

    return credentialEnv;
  }

  createHubServer(): express.Application {
    // TODO(samstern): Should not need this here but some tests are directly calling this method
    // because FunctionsEmulator.start() is not test-safe due to askInstallNodeVersion.
    this.workQueue.start();

    const hub = express();

    const dataMiddleware: express.RequestHandler = (req, res, next) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        (req as RequestWithRawBody).rawBody = Buffer.concat(chunks);
        next();
      });
    };

    // The URL for the function that the other emulators (Firestore, etc) use.
    // TODO(abehaskins): Make the other emulators use the route below and remove this.
    const backgroundFunctionRoute = `/functions/projects/:project_id/triggers/:trigger_name`;

    // The URL that the developer sees, this is the same URL that the legacy emulator used.
    const httpsFunctionRoute = `/${this.args.projectId}/:region/:trigger_name`;

    // The URL for events meant to trigger multiple functions
    const multicastFunctionRoute = `/functions/projects/:project_id/trigger_multicast`;

    // A trigger named "foo" needs to respond at "foo" as well as "foo/*" but not "fooBar".
    const httpsFunctionRoutes = [httpsFunctionRoute, `${httpsFunctionRoute}/*`];

    const backgroundHandler: express.RequestHandler = async (
      req: express.Request,
      res: express.Response
    ) => {
      const triggerId = req.params.trigger_name;
      const projectId = req.params.project_id;
      const reqBody = (req as RequestWithRawBody).rawBody;
      const proto = JSON.parse(reqBody.toString());

      // When background triggers are disabled just ignore the request and respond
      // with 204 "No Content"
      const record = this.triggers[triggerId];
      if (record && !record.enabled) {
        this.logger.log("DEBUG", `Ignoring background trigger: ${req.url}`);
        res.status(204).send();
        return;
      }

      this.workQueue.submit(() => {
        this.logger.log("DEBUG", `Accepted request ${req.method} ${req.url} --> ${triggerId}`);

        return this.handleBackgroundTrigger(projectId, triggerId, proto)
          .then((x) => res.json(x))
          .catch((errorBundle: { code: number; body?: string }) => {
            if (errorBundle.body) {
              res.status(errorBundle.code).send(errorBundle.body);
            } else {
              res.sendStatus(errorBundle.code);
            }
          });
      });
    };

    const httpsHandler: express.RequestHandler = async (
      req: express.Request,
      res: express.Response
    ) => {
      this.workQueue.submit(() => {
        return this.handleHttpsTrigger(req, res);
      });
    };

    const multicastHandler: express.RequestHandler = async (
      req: express.Request,
      res: express.Response
    ) => {
      const reqBody = (req as RequestWithRawBody).rawBody;
      const proto = JSON.parse(reqBody.toString());
      const triggers = this.multicastTriggers[`${this.args.projectId}:${proto.eventType}`] || [];
      const projectId = req.params.project_id;

      triggers.forEach((triggerId) => {
        this.workQueue.submit(() => {
          this.logger.log(
            "DEBUG",
            `Accepted multicast request ${req.method} ${req.url} --> ${triggerId}`
          );

          return this.handleBackgroundTrigger(projectId, triggerId, proto);
        });
      });

      res.json({ status: "multicast_acknowledged" });
    };

    // The ordering here is important. The longer routes (background)
    // need to be registered first otherwise the HTTP functions consume
    // all events.
    hub.post(backgroundFunctionRoute, dataMiddleware, backgroundHandler);
    hub.post(multicastFunctionRoute, dataMiddleware, multicastHandler);
    hub.all(httpsFunctionRoutes, dataMiddleware, httpsHandler);
    hub.all("*", dataMiddleware, (req, res) => {
      logger.debug(`Functions emulator received unknown request at path ${req.path}`);
      res.sendStatus(404);
    });
    return hub;
  }

  startFunctionRuntime(
    triggerId: string,
    triggerType: EmulatedTriggerType,
    proto?: any,
    runtimeOpts?: InvokeRuntimeOpts
  ): RuntimeWorker {
    const bundleTemplate = this.getBaseBundle();
    const runtimeBundle: FunctionsRuntimeBundle = {
      ...bundleTemplate,
      emulators: {
        firestore: this.getEmulatorInfo(Emulators.FIRESTORE),
        database: this.getEmulatorInfo(Emulators.DATABASE),
        pubsub: this.getEmulatorInfo(Emulators.PUBSUB),
        auth: this.getEmulatorInfo(Emulators.AUTH),
      },
      nodeMajorVersion: this.args.nodeMajorVersion,
      proto,
      triggerId,
      triggerType,
    };
    const opts = runtimeOpts || {
      nodeBinary: this.nodeBinary,
      env: this.args.env,
      extensionTriggers: this.args.predefinedTriggers,
    };
    const worker = this.invokeRuntime(runtimeBundle, opts);
    return worker;
  }

  async start(): Promise<void> {
    this.nodeBinary = this.askInstallNodeVersion(
      this.args.functionsDir,
      this.args.nodeMajorVersion
    );

    const credentialEnv = await this.getCredentialsEnvironment();
    this.args.env = {
      ...credentialEnv,
      ...this.args.env,
    };

    const { host, port } = this.getInfo();
    this.workQueue.start();
    const server = this.createHubServer().listen(port, host);
    this.destroyServer = createDestroyer(server);
    return Promise.resolve();
  }

  async connect(): Promise<void> {
    this.logger.logLabeled(
      "BULLET",
      "functions",
      `Watching "${this.args.functionsDir}" for Cloud Functions...`
    );

    const watcher = chokidar.watch(this.args.functionsDir, {
      ignored: [
        /.+?[\\\/]node_modules[\\\/].+?/, // Ignore node_modules
        /(^|[\/\\])\../, // Ignore files which begin the a period
        /.+\.log/, // Ignore files which have a .log extension
      ],
      persistent: true,
    });

    const debouncedLoadTriggers = _.debounce(() => this.loadTriggers(), 1000);
    watcher.on("change", (filePath) => {
      this.logger.log("DEBUG", `File ${filePath} changed, reloading triggers`);
      return debouncedLoadTriggers();
    });

    return this.loadTriggers();
  }

  async stop(): Promise<void> {
    try {
      await this.workQueue.flush();
    } catch (e) {
      this.logger.logLabeled(
        "WARN",
        "functions",
        "Functions emulator work queue did not empty before stopping"
      );
    }

    this.workQueue.stop();
    this.workerPool.exit();
    if (this.destroyServer) {
      await this.destroyServer();
    }
  }

  /**
   * When a user changes their code, we need to look for triggers defined in their updates sources.
   * To do this, we spin up a "diagnostic" runtime invocation. In other words, we pretend we're
   * going to invoke a cloud function in the emulator, but stop short of actually running a function.
   * Instead, we set up the environment and catch a special "triggers-parsed" log from the runtime
   * then exit out.
   *
   * A "diagnostic" FunctionsRuntimeBundle looks just like a normal bundle except triggerId == "".
   *
   * TODO(abehaskins): Gracefully handle removal of deleted function definitions
   */
  async loadTriggers() {
    // Before loading any triggers we need to make sure there are no 'stale' workers
    // in the pool that would cause us to run old code.
    this.workerPool.refresh();

    const worker = this.invokeRuntime(this.getBaseBundle(), {
      nodeBinary: this.nodeBinary,
      env: this.args.env,
      extensionTriggers: this.args.predefinedTriggers,
    });

    const triggerParseEvent = await EmulatorLog.waitForLog(
      worker.runtime.events,
      "SYSTEM",
      "triggers-parsed"
    );
    const triggerDefinitions = triggerParseEvent.data
      .triggerDefinitions as EmulatedTriggerDefinition[];

    const triggerResults: TriggerDescription[] = [];

    const toSetup = triggerDefinitions.filter((definition) => !this.triggers[definition.name]);

    for (const definition of toSetup) {
      if (definition.httpsTrigger) {
        // TODO(samstern): Right now we only emulate each function in one region, but it's possible
        //                 that a developer is running the same function in multiple regions.
        const region = getFunctionRegion(definition);
        const { host, port } = this.getInfo();
        const url = FunctionsEmulator.getHttpFunctionUrl(
          host,
          port,
          this.args.projectId,
          definition.name,
          region
        );

        triggerResults.push({
          name: definition.name,
          entryPoint: definition.entryPoint,
          type: "http",
          labels: definition.labels,
          details: url,
        });
      } else {
        const service: string = getFunctionService(definition);
        const result: TriggerDescription = {
          name: definition.name,
          entryPoint: definition.entryPoint,
          type: Constants.getServiceName(service),
          labels: definition.labels,
        };

        let added = false;
        switch (service) {
          case Constants.SERVICE_FIRESTORE:
            added = await this.addFirestoreTrigger(this.args.projectId, definition);
            break;
          case Constants.SERVICE_REALTIME_DATABASE:
            added = await this.addRealtimeDatabaseTrigger(this.args.projectId, definition);
            break;
          case Constants.SERVICE_PUBSUB:
            added = await this.addPubsubTrigger(this.args.projectId, definition);
            break;
          case Constants.SERVICE_AUTH:
            added = this.addAuthTrigger(this.args.projectId, definition);
            break;
          default:
            this.logger.log("DEBUG", `Unsupported trigger: ${JSON.stringify(definition)}`);
            break;
        }
        result.ignored = !added;
        triggerResults.push(result);
      }

      this.addTriggerRecord(definition);
    }

    const successTriggers = triggerResults.filter((r) => !r.ignored);
    for (const result of successTriggers) {
      const msg = result.details
        ? `${clc.bold(result.type)} function initialized (${result.details}).`
        : `${clc.bold(result.type)} function initialized.`;
      this.logger.logLabeled("SUCCESS", `functions[${result.entryPoint}]`, msg);
    }

    const ignoreTriggers = triggerResults.filter((r) => r.ignored);
    for (const result of ignoreTriggers) {
      const msg = `function ignored because the ${result.type} emulator does not exist or is not running.`;
      this.logger.logLabeled("BULLET", `functions[${result.entryPoint}]`, msg);
    }
  }

  addRealtimeDatabaseTrigger(
    projectId: string,
    definition: EmulatedTriggerDefinition
  ): Promise<boolean> {
    const databaseEmu = EmulatorRegistry.get(Emulators.DATABASE);
    if (!databaseEmu) {
      return Promise.resolve(false);
    }

    if (!definition.eventTrigger) {
      this.logger.log(
        "WARN",
        `Event trigger "${definition.name}" has undefined "eventTrigger" member`
      );
      return Promise.reject();
    }

    const result: string[] | null = DATABASE_PATH_PATTERN.exec(definition.eventTrigger.resource);
    if (result === null || result.length !== 3) {
      this.logger.log(
        "WARN",
        `Event trigger "${definition.name}" has malformed "resource" member. ` +
          `${definition.eventTrigger.resource}`
      );
      return Promise.reject();
    }

    const instance = result[1];
    const bundle = JSON.stringify({
      name: `projects/${projectId}/locations/_/functions/${definition.name}`,
      path: result[2], // path stored in the second capture group
      event: definition.eventTrigger.eventType,
      topic: `projects/${projectId}/topics/${definition.name}`,
    });

    logger.debug(`addRealtimeDatabaseTrigger[${instance}]`, JSON.stringify(bundle));

    let setTriggersPath = "/.settings/functionTriggers.json";
    if (instance !== "") {
      setTriggersPath += `?ns=${instance}`;
    } else {
      this.logger.log(
        "WARN",
        `No project in use. Registering function trigger for sentinel namespace '${Constants.DEFAULT_DATABASE_EMULATOR_NAMESPACE}'`
      );
    }

    return api
      .request("POST", setTriggersPath, {
        origin: `http://${EmulatorRegistry.getInfoHostString(databaseEmu.getInfo())}`,
        headers: {
          Authorization: "Bearer owner",
        },
        data: bundle,
        json: false,
      })
      .then(() => {
        return true;
      })
      .catch((err) => {
        this.logger.log("WARN", "Error adding trigger: " + err);
        throw err;
      });
  }

  addFirestoreTrigger(projectId: string, definition: EmulatedTriggerDefinition): Promise<boolean> {
    const firestoreEmu = EmulatorRegistry.get(Emulators.FIRESTORE);
    if (!firestoreEmu) {
      return Promise.resolve(false);
    }

    const bundle = JSON.stringify({ eventTrigger: definition.eventTrigger });
    logger.debug(`addFirestoreTrigger`, JSON.stringify(bundle));

    return api
      .request("PUT", `/emulator/v1/projects/${projectId}/triggers/${definition.name}`, {
        origin: `http://${EmulatorRegistry.getInfoHostString(firestoreEmu.getInfo())}`,
        data: bundle,
        json: false,
      })
      .then(() => {
        return true;
      })
      .catch((err) => {
        this.logger.log("WARN", "Error adding trigger: " + err);
        throw err;
      });
  }

  async addPubsubTrigger(
    projectId: string,
    definition: EmulatedTriggerDefinition
  ): Promise<boolean> {
    const pubsubPort = EmulatorRegistry.getPort(Emulators.PUBSUB);
    if (!pubsubPort) {
      return false;
    }

    if (!definition.eventTrigger) {
      return false;
    }

    const pubsubEmulator = EmulatorRegistry.get(Emulators.PUBSUB) as PubsubEmulator;

    logger.debug(`addPubsubTrigger`, JSON.stringify({ eventTrigger: definition.eventTrigger }));

    // "resource":\"projects/{PROJECT_ID}/topics/{TOPIC_ID}";
    const resource = definition.eventTrigger.resource;
    let topic;
    if (definition.schedule) {
      // In production this topic looks like
      // "firebase-schedule-{FUNCTION_NAME}-{DEPLOY-LOCATION}", we simply drop
      // the deploy location to match as closely as possible.
      topic = "firebase-schedule-" + definition.name;
    } else {
      const resourceParts = resource.split("/");
      topic = resourceParts[resourceParts.length - 1];
    }

    try {
      await pubsubEmulator.addTrigger(topic, definition.name);
      return true;
    } catch (e) {
      return false;
    }
  }

  addAuthTrigger(projectId: string, definition: EmulatedTriggerDefinition): boolean {
    logger.debug(`addAuthTrigger`, JSON.stringify({ eventTrigger: definition.eventTrigger }));

    const eventTriggerId = `${projectId}:${definition.eventTrigger?.eventType}`;
    const triggers = this.multicastTriggers[eventTriggerId] || [];
    triggers.push(definition.entryPoint);
    this.multicastTriggers[eventTriggerId] = triggers;
    return true;
  }

  getProjectId(): string {
    return this.args.projectId;
  }

  getInfo(): EmulatorInfo {
    const host = this.args.host || Constants.getDefaultHost(Emulators.FUNCTIONS);
    const port = this.args.port || Constants.getDefaultPort(Emulators.FUNCTIONS);

    return {
      name: this.getName(),
      host,
      port,
    };
  }

  getName(): Emulators {
    return Emulators.FUNCTIONS;
  }

  getTriggerDefinitions(): EmulatedTriggerDefinition[] {
    return Object.values(this.triggers).map((record) => record.def);
  }

  getTriggerDefinitionByName(triggerName: string): EmulatedTriggerDefinition {
    const record = this.triggers[triggerName];
    if (!record) {
      throw new FirebaseError(`No trigger with name ${triggerName}`);
    }

    return record.def;
  }

  addTriggerRecord(def: EmulatedTriggerDefinition) {
    this.triggers[def.name] = { def, enabled: true };
  }

  setTriggersForTesting(triggers: EmulatedTriggerDefinition[]) {
    triggers.forEach((def) => this.addTriggerRecord(def));
  }

  getBaseBundle(): FunctionsRuntimeBundle {
    return {
      cwd: this.args.functionsDir,
      projectId: this.args.projectId,
      triggerId: "",
      triggerType: undefined,
      triggerGeneration: this.triggerGeneration,
      emulators: {
        firestore: EmulatorRegistry.getInfo(Emulators.FIRESTORE),
        database: EmulatorRegistry.getInfo(Emulators.DATABASE),
        pubsub: EmulatorRegistry.getInfo(Emulators.PUBSUB),
        auth: EmulatorRegistry.getInfo(Emulators.AUTH),
      },
      disabled_features: this.args.disabledRuntimeFeatures,
    };
  }
  /**
   * Returns a node major version ("10", "8") or null
   * @param frb the current Functions Runtime Bundle
   */
  getRequestedNodeRuntimeVersion(frb: FunctionsRuntimeBundle): string | undefined {
    const pkg = require(path.join(frb.cwd, "package.json"));
    return frb.nodeMajorVersion || (pkg.engines && pkg.engines.node);
  }
  /**
   * Returns the path to a "node" executable to use.
   * @param cwd the directory to checkout for a package.json file.
   * @param nodeMajorVersion forces the emulator to choose this version. Used when emulating extensions,
   *  since in production, extensions ignore the node version provided in package.json and use the version
   *  specified in extension.yaml. This will ALWAYS be populated when emulating extensions, even if they
   *  are using the default version.
   */
  askInstallNodeVersion(cwd: string, nodeMajorVersion?: number): string {
    const pkg = require(path.join(cwd, "package.json"));
    // If the developer hasn't specified a Node to use, inform them that it's an option and use default
    if ((!pkg.engines || !pkg.engines.node) && !nodeMajorVersion) {
      this.logger.log(
        "WARN",
        "Your functions directory does not specify a Node version.\n   " +
          "- Learn more at https://firebase.google.com/docs/functions/manage-functions#set_runtime_options"
      );
      return process.execPath;
    }

    const hostMajorVersion = process.versions.node.split(".")[0];
    const requestedMajorVersion: string = nodeMajorVersion
      ? `${nodeMajorVersion}`
      : pkg.engines.node;
    let localMajorVersion = "0";
    const localNodePath = path.join(cwd, "node_modules/.bin/node");

    // Next check if we have a Node install in the node_modules folder
    try {
      const localNodeOutput = spawnSync(localNodePath, ["--version"]).stdout.toString();
      localMajorVersion = localNodeOutput.slice(1).split(".")[0];
    } catch (err) {
      // Will happen if we haven't asked about local version yet
    }

    // If the requested version is already locally available, let's use that
    if (requestedMajorVersion === localMajorVersion) {
      this.logger.logLabeled(
        "SUCCESS",
        "functions",
        `Using node@${requestedMajorVersion} from local cache.`
      );
      return localNodePath;
    }

    // If the requested version is the same as the host, let's use that
    if (requestedMajorVersion === hostMajorVersion) {
      this.logger.logLabeled(
        "SUCCESS",
        "functions",
        `Using node@${requestedMajorVersion} from host.`
      );
      return process.execPath;
    }

    // Otherwise we'll begin the conversational flow to install the correct version locally
    this.logger.log(
      "WARN",
      `Your requested "node" version "${requestedMajorVersion}" doesn't match your global version "${hostMajorVersion}"`
    );

    return process.execPath;
  }

  invokeRuntime(frb: FunctionsRuntimeBundle, opts: InvokeRuntimeOpts): RuntimeWorker {
    // If we can use an existing worker there is almost nothing to do.
    if (this.workerPool.readyForWork(frb.triggerId)) {
      return this.workerPool.submitWork(frb.triggerId, frb, opts);
    }

    const emitter = new EventEmitter();
    const args = [path.join(__dirname, "functionsEmulatorRuntime")];

    if (opts.ignore_warnings) {
      args.unshift("--no-warnings");
    }

    if (this.args.debugPort) {
      if (process.env.FIREPIT_VERSION && process.execPath == opts.nodeBinary) {
        const requestedMajorNodeVersion = this.getRequestedNodeRuntimeVersion(frb);
        this.logger.log(
          "WARN",
          `To enable function inspection, please run "${process.execPath} is:npm i node@${requestedMajorNodeVersion} --save-dev" in your functions directory`
        );
      } else {
        const { host } = this.getInfo();
        args.unshift(`--inspect=${host}:${this.args.debugPort}`);
      }
    }

    const childProcess = spawn(opts.nodeBinary, args, {
      env: { node: opts.nodeBinary, ...opts.env, ...process.env },
      cwd: frb.cwd,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    const buffers: {
      [pipe: string]: {
        pipe: stream.Readable;
        value: string;
      };
    } = {
      stderr: { pipe: childProcess.stderr, value: "" },
      stdout: { pipe: childProcess.stdout, value: "" },
    };

    const ipcBuffer = { value: "" };
    childProcess.on("message", (message: any) => {
      this.onData(childProcess, emitter, ipcBuffer, message);
    });

    for (const id in buffers) {
      if (buffers.hasOwnProperty(id)) {
        const buffer = buffers[id];
        buffer.pipe.on("data", (buf: Buffer) => {
          this.onData(childProcess, emitter, buffer, buf);
        });
      }
    }

    const runtime: FunctionsRuntimeInstance = {
      pid: childProcess.pid,
      exit: new Promise<number>((resolve) => {
        childProcess.on("exit", resolve);
      }),
      events: emitter,
      shutdown: () => {
        childProcess.kill();
      },
      kill: (signal?: string) => {
        childProcess.kill(signal);
        emitter.emit("log", new EmulatorLog("SYSTEM", "runtime-status", "killed"));
      },
      send: (args: FunctionsRuntimeArgs) => {
        return childProcess.send(JSON.stringify(args));
      },
    };

    this.workerPool.addWorker(frb.triggerId, runtime);
    return this.workerPool.submitWork(frb.triggerId, frb, opts);
  }

  disableBackgroundTriggers() {
    Object.values(this.triggers).forEach((record) => {
      if (record.def.eventTrigger) {
        this.logger.logLabeled(
          "BULLET",
          `functions[${record.def.entryPoint}]`,
          "function temporarily disabled."
        );
        record.enabled = false;
      }
    });
  }

  async reloadTriggers() {
    this.triggerGeneration++;
    return this.loadTriggers();
  }

  private async handleBackgroundTrigger(projectId: string, triggerId: string, proto: any) {
    const trigger = this.getTriggerDefinitionByName(triggerId);
    const service = getFunctionService(trigger);
    const worker = this.startFunctionRuntime(triggerId, EmulatedTriggerType.BACKGROUND, proto);

    return new Promise((resolve, reject) => {
      if (projectId !== this.args.projectId) {
        // RTDB considers each namespace a "project", but for any other trigger we want to reject
        // incoming triggers to a different project.
        if (service !== Constants.SERVICE_REALTIME_DATABASE) {
          logger.debug(
            `Received functions trigger for service "${service}" for unknown project "${projectId}".`
          );
          reject({ code: 404 });
          return;
        }

        // The eventTrigger 'resource' property will look something like this:
        // "projects/_/instances/<project>/refs/foo/bar"
        // If the trigger's resource does not match the invoked projet ID, we should 404.
        if (!trigger.eventTrigger!.resource.startsWith(`projects/_/instances/${projectId}`)) {
          logger.debug(
            `Received functions trigger for function "${triggerId}" of project "${projectId}" that did not match definition: ${JSON.stringify(
              trigger
            )}.`
          );
          reject({ code: 404 });
          return;
        }
      }

      worker.onLogs((el: EmulatorLog) => {
        if (el.level === "FATAL") {
          reject({ code: 500, body: el.text });
        }
      });

      // For analytics, track the invoked service
      if (triggerId) {
        const trigger = this.getTriggerDefinitionByName(triggerId);
        track(EVENT_INVOKE, getFunctionService(trigger));
      }

      worker.waitForDone().then(() => {
        resolve({ status: "acknowledged" });
      });
    });
  }

  /**
   * Gets the address of a running emulator, either from explicit args or by
   * consulting the emulator registry.
   *
   * @param emulator
   */
  private getEmulatorInfo(emulator: Emulators): EmulatorInfo | undefined {
    if (this.args.remoteEmulators) {
      if (this.args.remoteEmulators[emulator]) {
        return this.args.remoteEmulators[emulator];
      }
    }

    return EmulatorRegistry.getInfo(emulator);
  }

  private tokenFromAuthHeader(authHeader: string) {
    const match = authHeader.match(/^Bearer (.*)$/);
    if (!match) {
      return;
    }

    let idToken = match[1];
    logger.debug(`ID Token: ${idToken}`);

    // The @firebase/testing library sometimes produces JWTs with invalid padding, so we
    // remove that via regex. This is the spec that says trailing = should be removed:
    // https://tools.ietf.org/html/rfc7515#section-2
    if (idToken && idToken.includes("=")) {
      idToken = idToken.replace(/[=]+?\./g, ".");
      logger.debug(`ID Token contained invalid padding, new value: ${idToken}`);
    }

    try {
      const decoded = jwt.decode(idToken, { complete: true });
      if (!decoded || typeof decoded !== "object") {
        logger.debug(`Failed to decode ID Token: ${decoded}`);
        return;
      }

      // In firebase-functions we manually copy 'sub' to 'uid'
      // https://github.com/firebase/firebase-admin-node/blob/0b2082f1576f651e75069e38ce87e639c25289af/src/auth/token-verifier.ts#L249
      const claims = decoded.payload;
      claims.uid = claims.sub;

      return claims;
    } catch (e) {
      return;
    }
  }

  private async handleHttpsTrigger(req: express.Request, res: express.Response) {
    const method = req.method;
    const triggerId = req.params.trigger_name;
    const trigger = this.getTriggerDefinitionByName(triggerId);

    logger.debug(`Accepted request ${method} ${req.url} --> ${triggerId}`);

    const reqBody = (req as RequestWithRawBody).rawBody;

    // For callable functions we want to accept tokens without actually calling verifyIdToken
    const isCallable = trigger.labels && trigger.labels["deployment-callable"] === "true";
    const authHeader = req.header("Authorization");
    if (authHeader && isCallable) {
      const token = this.tokenFromAuthHeader(authHeader);
      if (token) {
        const contextAuth = {
          uid: token.uid,
          token: token,
        };

        // Stash the "Authorization" header in a temporary place, we will replace it
        // when invoking the callable handler
        req.headers[HttpConstants.ORIGINAL_AUTH_HEADER] = req.headers["authorization"];
        delete req.headers["authorization"];

        req.headers[HttpConstants.CALLABLE_AUTH_HEADER] = encodeURIComponent(
          JSON.stringify(contextAuth)
        );
      }
    }

    const worker = this.startFunctionRuntime(triggerId, EmulatedTriggerType.HTTPS, undefined);

    worker.onLogs((el: EmulatorLog) => {
      if (el.level === "FATAL") {
        res.status(500).send(el.text);
      }
    });

    // Wait for the worker to set up its internal HTTP server
    await worker.waitForSocketReady();

    track(EVENT_INVOKE, "https");

    this.logger.log("DEBUG", `[functions] Runtime ready! Sending request!`);

    if (!worker.lastArgs) {
      throw new FirebaseError("Cannot execute on a worker with no arguments");
    }

    if (!worker.lastArgs.frb.socketPath) {
      throw new FirebaseError(
        `Cannot execute on a worker without a socketPath: ${JSON.stringify(worker.lastArgs)}`
      );
    }

    // We do this instead of just 302'ing because many HTTP clients don't respect 302s so it may
    // cause unexpected situations - not to mention CORS troubles and this enables us to use
    // a socketPath (IPC socket) instead of consuming yet another port which is probably faster as well.
    const runtimeReq = http.request(
      {
        method,
        path: req.url || "/",
        headers: req.headers,
        socketPath: worker.lastArgs.frb.socketPath,
      },
      (runtimeRes: http.IncomingMessage) => {
        function forwardStatusAndHeaders(): void {
          res.status(runtimeRes.statusCode || 200);
          if (!res.headersSent) {
            Object.keys(runtimeRes.headers).forEach((key) => {
              const val = runtimeRes.headers[key];
              if (val) {
                res.setHeader(key, val);
              }
            });
          }
        }

        runtimeRes.on("data", (buf) => {
          forwardStatusAndHeaders();
          res.write(buf);
        });

        runtimeRes.on("close", () => {
          forwardStatusAndHeaders();
          res.end();
        });

        runtimeRes.on("end", () => {
          forwardStatusAndHeaders();
          res.end();
        });
      }
    );

    runtimeReq.on("error", () => {
      res.end();
    });

    // If the original request had a body, forward that over the connection.
    // TODO: Why is this not handled by the pipe?
    if (reqBody) {
      runtimeReq.write(reqBody);
      runtimeReq.end();
    }

    // Pipe the incoming request over the socket.
    req.pipe(runtimeReq, { end: true }).on("error", () => {
      res.end();
    });

    await worker.waitForDone();
  }

  private onData(
    runtime: ChildProcess,
    emitter: EventEmitter,
    buffer: { value: string },
    buf: Buffer
  ): void {
    buffer.value += buf.toString();

    const lines = buffer.value.split("\n");

    if (lines.length > 1) {
      // slice(0, -1) returns all elements but the last
      lines.slice(0, -1).forEach((line: string) => {
        const log = EmulatorLog.fromJSON(line);
        emitter.emit("log", log);

        if (log.level === "FATAL") {
          // Something went wrong, if we don't kill the process it'll wait for timeoutMs.
          emitter.emit("log", new EmulatorLog("SYSTEM", "runtime-status", "killed"));
          runtime.kill();
        }
      });
    }

    buffer.value = lines[lines.length - 1];
  }
}
