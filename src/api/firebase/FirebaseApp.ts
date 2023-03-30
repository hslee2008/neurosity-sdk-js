import firebase from "firebase/compat/app";
import "firebase/compat/database";
import "firebase/compat/auth";
import "firebase/compat/functions";
import "firebase/compat/firestore";

import { config } from "./config";
import { SDKOptions } from "../../types/options";

export const SERVER_TIMESTAMP = firebase.database.ServerValue.TIMESTAMP;

/**
 * @hidden
 */
export class FirebaseApp {
  protected standalone: boolean;
  public app: firebase.app.App;

  constructor(options: SDKOptions) {
    this.app = this.getApp(options.deviceId);
    this.standalone = this.app.name === options.deviceId;

    if (options.emulator) {
      this.connectEmulators(options);
    }
  }

  private getApp(deviceId?: string) {
    const moduleApps = firebase.apps;
    const browserApps =
      typeof window !== "undefined" &&
      "firebase" in window &&
      "apps" in window.firebase
        ? window["firebase"]["apps"]
        : [];

    const neurosityApp = [...moduleApps, ...(browserApps as any[])].find(
      (app: any) =>
        app.name === "[DEFAULT]" &&
        app.options.databaseURL === config.databaseURL
    );

    if (neurosityApp) {
      return neurosityApp;
    }

    if (deviceId) {
      const neurosityAppName = deviceId;
      const neurosityApp = moduleApps.find(
        (app) => app.name === neurosityAppName
      );
      return neurosityApp
        ? neurosityApp
        : firebase.initializeApp(config, neurosityAppName);
    }

    return firebase.initializeApp(config);
  }

  connectEmulators(options: SDKOptions) {
    const {
      emulatorHost,
      emulatorAuthPort,
      emulatorDatabasePort,
      emulatorFunctionsPort,
      emulatorFirestorePort,
      emulatorOptions
    } = options;

    this.app.auth().useEmulator(`http://${emulatorHost}:${emulatorAuthPort}`);
    this.app
      .database()
      .useEmulator(emulatorHost, emulatorDatabasePort, emulatorOptions);
    this.app.functions().useEmulator(emulatorHost, emulatorFunctionsPort);
    this.app
      .firestore()
      .useEmulator(emulatorHost, emulatorFirestorePort, emulatorOptions);
  }

  goOnline() {
    this.app.database().goOnline();
  }

  goOffline() {
    this.app.database().goOffline();
  }

  public disconnect(): Promise<any> {
    if (this.standalone) {
      return this.app.delete();
    }
    return Promise.resolve();
  }
}
