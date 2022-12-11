import { BLUETOOTH_PRIMARY_SERVICE_UUID_STRING } from "@neurosity/ipk";
import { BLUETOOTH_CHUNK_DELIMITER } from "@neurosity/ipk";
import { BLUETOOTH_DEVICE_NAME_PREFIXES } from "@neurosity/ipk";
import { BehaviorSubject, defer, merge, of, ReplaySubject, timer } from "rxjs";
import { fromEventPattern, Observable, NEVER, EMPTY } from "rxjs";
import { switchMap, map, filter, takeUntil, tap } from "rxjs/operators";
import { shareReplay, distinctUntilChanged, finalize } from "rxjs/operators";
import { take, share, scan } from "rxjs/operators";

import { BluetoothTransport } from "../BluetoothTransport";
import { create6DigitPin } from "../utils/create6DigitPin";
import { stitchChunks } from "../utils/stitch";
import { encode, decode } from "../utils/encoding";
import { ActionOptions, SubscribeOptions } from "../types";
import { TRANSPORT_TYPE, BLUETOOTH_CONNECTION } from "../types";
import { BleManager } from "./types/BleManagerTypes";
import { Peripheral, PeripheralInfo } from "./types/BleManagerTypes";
import { NativeEventEmitter } from "./types/ReactNativeTypes";
import { PlatformOSType } from "./types/ReactNativeTypes";
import { DEFAULT_ACTION_RESPONSE_TIMEOUT } from "../constants";
import { CHARACTERISTIC_UUIDS_TO_NAMES } from "../constants";
import { ANDROID_MAX_MTU } from "../constants";
import { REACT_NATIVE_MAX_BYTE_SIZE } from "../constants";
import { DeviceInfo } from "../../../types/deviceInfo";
import { osHasBluetoothSupport } from "../utils/osHasBluetoothSupport";

type Characteristic = {
  characteristicUUID: string;
  serviceUUID: string;
  peripheralId: string;
};

type CharacteristicsByName = {
  [name: string]: Characteristic;
};

type Options = {
  BleManager: BleManager;
  bleManagerEmitter: NativeEventEmitter;
  platform: PlatformOSType;
};

type BleManagerEvents = {
  stopScan$: Observable<void>;
  discoverPeripheral$: Observable<Peripheral>;
  connectPeripheral$: Observable<void>;
  disconnectPeripheral$: Observable<void>;
  didUpdateValueForCharacteristic$: Observable<any>;
};

export class ReactNativeTransport implements BluetoothTransport {
  type: TRANSPORT_TYPE = TRANSPORT_TYPE.REACT_NATIVE;
  BleManager: BleManager;
  bleManagerEmitter: NativeEventEmitter;
  platform: PlatformOSType;
  bleEvents: BleManagerEvents;

  device: Peripheral;
  characteristicsByName: CharacteristicsByName = {};

  connection$ = new BehaviorSubject<BLUETOOTH_CONNECTION>(
    BLUETOOTH_CONNECTION.DISCONNECTED
  );
  pendingActions$ = new BehaviorSubject<any[]>([]);
  logs$ = new ReplaySubject<string>(10);
  onDisconnected$: Observable<void>;
  connectionStream$: Observable<BLUETOOTH_CONNECTION> = this.connection$
    .asObservable()
    .pipe(
      filter((connection) => !!connection),
      distinctUntilChanged(),
      shareReplay(1)
    );

  constructor(options: Options) {
    const { BleManager, bleManagerEmitter, platform } = options;

    if (!BleManager) {
      const errorMessage = "React Native option: BleManager not provided.";
      this.addLog(errorMessage);
      throw new Error(errorMessage);
    }

    if (!bleManagerEmitter) {
      const errorMessage =
        "React Native option: bleManagerEmitter not provided.";
      this.addLog(errorMessage);
      throw new Error(errorMessage);
    }

    if (!platform) {
      const errorMessage = "React Native option: platform not provided.";
      this.addLog(errorMessage);
      throw new Error(errorMessage);
    }

    this.BleManager = BleManager;
    this.bleManagerEmitter = bleManagerEmitter;
    this.platform = platform;

    // We create a single listener per event type to
    // avoid missing events when multiple listeners are attached.
    this.bleEvents = {
      stopScan$: this._fromEvent("BleManagerStopScan"),
      discoverPeripheral$: this._fromEvent("BleManagerDiscoverPeripheral"),
      connectPeripheral$: this._fromEvent("BleManagerConnectPeripheral"),
      disconnectPeripheral$: this._fromEvent("BleManagerDisconnectPeripheral"),
      didUpdateValueForCharacteristic$: this._fromEvent(
        "BleManagerDidUpdateValueForCharacteristic"
      )
    };

    this.onDisconnected$ = this.bleEvents.disconnectPeripheral$.pipe(share());

    // Initializes the module. This can only be called once.
    this.BleManager.start({ showAlert: false })
      .then(() => {
        this.addLog(`BleManger started`);
      })
      .catch((error) => {
        this.addLog(`BleManger failed to start. ${error?.message ?? error}`);
      });

    this.connection$.asObservable().subscribe((connection) => {
      this.addLog(`connection status is ${connection}`);
    });

    this.onDisconnected$.subscribe(() => {
      this.connection$.next(BLUETOOTH_CONNECTION.DISCONNECTED);
    });
  }

  addLog(log: string) {
    this.logs$.next(log);
  }

  isConnected() {
    const connection = this.connection$.getValue();
    return connection === BLUETOOTH_CONNECTION.CONNECTED;
  }

  _autoConnect(selectedDevice$: Observable<DeviceInfo>): Observable<void> {
    const selectedDeviceAfterDisconnect$ = this.onDisconnected$.pipe(
      switchMap(() => selectedDevice$)
    );

    return merge(selectedDevice$, selectedDeviceAfterDisconnect$).pipe(
      switchMap((selectedDevice) =>
        !osHasBluetoothSupport(selectedDevice)
          ? EMPTY
          : this.scan().pipe(
              switchMap((peripherals) => {
                const peripheral = peripherals.find(
                  (peripheral) =>
                    peripheral.name === selectedDevice?.deviceNickname
                );

                return peripheral ? of(peripheral) : EMPTY;
              }),
              take(1)
            )
      ),
      switchMap(async (peripheral) => {
        return await this.connect(peripheral);
      })
    );
  }

  connection(): Observable<BLUETOOTH_CONNECTION> {
    return this.connectionStream$;
  }

  _fromEvent(eventName: string): Observable<any> {
    return fromEventPattern(
      (addHandler) => {
        this.bleManagerEmitter.addListener(eventName, addHandler);
      },
      () => {
        this.bleManagerEmitter.removeAllListeners(eventName);
      }
    ).pipe(
      // @important: we need to share the subscription
      // to avoid missing events
      share()
    );
  }

  scan(options?: {
    seconds?: number;
    once?: boolean;
  }): Observable<Peripheral[]> {
    const RESCAN_INTERVAL = 10_000; // 10 seconds
    const seconds = options?.seconds ?? RESCAN_INTERVAL / 1000;
    const once = options?.once ?? false;
    const serviceUUIDs = [BLUETOOTH_PRIMARY_SERVICE_UUID_STRING];
    const allowDuplicates = true;
    const scanOptions = {};

    const scanOnce$ = new Observable((subscriber) => {
      try {
        this.BleManager.scan(
          serviceUUIDs,
          seconds,
          allowDuplicates,
          scanOptions
        ).then(() => {
          this.addLog(`BleManger scanning ${once ? "once" : "indefintely"}`);
          subscriber.next();
        });
      } catch (error) {
        this.addLog(
          `BleManger scanning ${once ? "once" : "indefintely"} failed. ${
            error?.message ?? error
          }`
        );
        subscriber.error(error);
      }

      return () => {
        this.BleManager.stopScan();
      };
    });

    const scan$ = once
      ? scanOnce$
      : timer(0, RESCAN_INTERVAL).pipe(switchMap(() => scanOnce$));

    const peripherals$ = scan$.pipe(
      tap(() => {
        this.connection$.next(BLUETOOTH_CONNECTION.SCANNING);
      }),
      takeUntil(this.onDisconnected$),
      switchMap(() => this.bleEvents.discoverPeripheral$),
      // Filter out devices that are not Neurosity devices
      filter((peripheral: Peripheral) => {
        const peripheralName: string =
          peripheral?.advertising?.localName ?? peripheral.name ?? "";

        if (!peripheralName) {
          return false;
        }

        const startsWithPrefix =
          BLUETOOTH_DEVICE_NAME_PREFIXES.findIndex((prefix) =>
            peripheralName.startsWith(prefix)
          ) !== -1;

        return startsWithPrefix;
      }),
      scan((acc, peripheral): { [name: string]: Peripheral } => {
        // normalized peripheral name for backwards compatibility
        // Neurosity OS v15 doesn't have peripheral.name as deviceNickname
        // it only has peripheral.advertising.localName as deviceNickname
        // and OS v16 has both as deviceNickname
        const peripheralName: string =
          peripheral?.advertising?.localName ?? peripheral.name ?? "";

        const manufactureDataString = decode(
          this.type,
          peripheral?.advertising?.manufacturerData?.bytes ?? []
        )?.slice?.(2); // First 2 bytes are reserved for the Neurosity company code

        return {
          ...acc,
          [peripheral.id]: {
            ...peripheral,
            name: peripheralName,
            manufactureDataString
          }
        };
      }, {}),
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      map((peripheralMap): Peripheral[] => Object.values(peripheralMap)),
      share()
    );

    return peripherals$;
  }

  async connect(peripheral: Peripheral): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        if (!peripheral) {
          this.addLog("Peripheral not found");
          return;
        }

        this.connection$.next(BLUETOOTH_CONNECTION.CONNECTING);

        await this.BleManager.connect(peripheral.id);

        this.addLog(`Getting service...`);

        const peripheralInfo: PeripheralInfo =
          await this.BleManager.retrieveServices(peripheral.id, [
            BLUETOOTH_PRIMARY_SERVICE_UUID_STRING
          ]);

        if (!peripheralInfo) {
          this.addLog("Could not retreive services");
          reject(`Could not retreive services`);
          return;
        }

        this.addLog(
          `Got service ${BLUETOOTH_PRIMARY_SERVICE_UUID_STRING}, getting characteristics...`
        );

        this.device = peripheral;

        this.characteristicsByName = Object.fromEntries(
          peripheralInfo.characteristics.map((characteristic: any) => [
            CHARACTERISTIC_UUIDS_TO_NAMES[
              characteristic.characteristic.toLowerCase() // react native uses uppercase
            ],
            {
              characteristicUUID: characteristic.characteristic,
              serviceUUID: characteristic.service,
              peripheralId: peripheral.id
            }
          ])
        );

        this.addLog(`Got characteristics.`);

        if (this.platform === "android") {
          this.addLog(`Setting Android MTU to ${ANDROID_MAX_MTU}`);
          await this.BleManager.requestMTU(peripheral.id, ANDROID_MAX_MTU);
        }

        this.addLog(`Successfully connected to peripheral ${peripheral.id}`);

        this.connection$.next(BLUETOOTH_CONNECTION.CONNECTED);

        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  async disconnect(): Promise<void> {
    try {
      if (this.isConnected() && this?.device?.id) {
        await this.BleManager.disconnect(this.device.id);
      }
    } catch (error) {
      return Promise.reject(error);
    }
  }

  getCharacteristicByName(characteristicName: string): Characteristic {
    if (!(characteristicName in this.characteristicsByName)) {
      throw new Error(
        `Characteristic by name ${characteristicName} is not found`
      );
    }

    return this.characteristicsByName?.[characteristicName];
  }

  subscribeToCharacteristic({
    characteristicName,
    manageNotifications = true
  }: SubscribeOptions): Observable<any> {
    const getData = ({
      peripheralId,
      serviceUUID,
      characteristicUUID
    }: Characteristic) =>
      defer(async () => {
        if (manageNotifications) {
          try {
            await this.BleManager.startNotification(
              peripheralId,
              serviceUUID,
              characteristicUUID
            );

            this.addLog(
              `Started notifications for ${characteristicName} characteristic`
            );
          } catch (error) {
            this.addLog(
              `Attemped to stop notifications for ${characteristicName} characteristic: ${
                error?.message ?? error
              }`
            );
          }
        }
      }).pipe(
        switchMap(() => this.bleEvents.didUpdateValueForCharacteristic$),
        finalize(async () => {
          if (manageNotifications) {
            try {
              await this.BleManager.stopNotification(
                peripheralId,
                serviceUUID,
                characteristicUUID
              );
              this.addLog(
                `Stopped notifications for ${characteristicName} characteristic`
              );
            } catch (error) {
              this.addLog(
                `Attemped to stop notifications for ${characteristicName} characteristic: ${
                  error?.message ?? error
                }`
              );
            }
          }
        }),
        filter(({ characteristic }) => characteristic === characteristicUUID),
        map(({ value }: { value: number[]; characteristic: string }): string =>
          decode(this.type, value)
        ),
        stitchChunks({ delimiter: BLUETOOTH_CHUNK_DELIMITER }),
        map((payload: any) => {
          try {
            return JSON.parse(payload);
          } catch (_) {
            return payload;
          }
        })
      );

    return this.connection$.pipe(
      switchMap((connection) =>
        connection === BLUETOOTH_CONNECTION.CONNECTED
          ? getData(this.getCharacteristicByName(characteristicName))
          : NEVER
      )
    );
  }

  async readCharacteristic(
    characteristicName: string,
    parse: boolean = false
  ): Promise<any> {
    this.addLog(`Reading characteristic: ${characteristicName}`);

    const { peripheralId, serviceUUID, characteristicUUID } =
      this.getCharacteristicByName(characteristicName);

    if (!characteristicUUID) {
      return Promise.reject(
        `Did not find characteristic matching ${characteristicName}`
      );
    }

    try {
      const value = await this.BleManager.read(
        peripheralId,
        serviceUUID,
        characteristicUUID
      );

      const decodedValue = decode(this.type, value);
      const data = parse ? JSON.parse(decodedValue) : decodedValue;

      this.addLog(
        `Received read data from ${characteristicName} characteristic: \n${data}`
      );

      return data;
    } catch (error) {
      return Promise.reject(
        `readCharacteristic ${characteristicName} error. ${
          error?.message ?? error
        }`
      );
    }
  }

  async writeCharacteristic(
    characteristicName: string,
    data: string
  ): Promise<void> {
    this.addLog(`Writing characteristic: ${characteristicName}`);

    const { peripheralId, serviceUUID, characteristicUUID } =
      this.getCharacteristicByName(characteristicName);

    if (!characteristicUUID) {
      return Promise.reject(
        `Did not find characteristic matching ${characteristicName}`
      );
    }

    const encoded = encode(this.type, data);

    await this.BleManager.write(
      peripheralId,
      serviceUUID,
      characteristicUUID,
      encoded,
      REACT_NATIVE_MAX_BYTE_SIZE
    );
  }

  _addPendingAction(actionId: number): void {
    const actions = this.pendingActions$.getValue();
    this.pendingActions$.next([...actions, actionId]);
  }

  _removePendingAction(actionId: number): void {
    const actions = this.pendingActions$.getValue();
    this.pendingActions$.next(
      actions.filter((id: number): boolean => id !== actionId)
    );
  }

  async _autoToggleActionNotifications(
    selectedDevice$: Observable<DeviceInfo>
  ): Promise<void> {
    let started: boolean = false;

    const sideEffects$ = this.connection$.asObservable().pipe(
      switchMap((connection) =>
        connection === BLUETOOTH_CONNECTION.CONNECTED
          ? this.pendingActions$
          : NEVER
      ),
      tap(async (pendingActions: string[]) => {
        const { peripheralId, serviceUUID, characteristicUUID } =
          this.getCharacteristicByName("actions");

        const hasPendingActions = !!pendingActions.length;

        if (hasPendingActions && !started) {
          started = true;
          try {
            await this.BleManager.startNotification(
              peripheralId,
              serviceUUID,
              characteristicUUID
            );
            this.addLog(`Started notifications for [actions] characteristic`);
          } catch (error) {
            this.addLog(
              `Attemped to start notifications for [actions] characteristic: ${
                error?.message ?? error
              }`
            );
          }
        }

        if (!hasPendingActions && started) {
          started = false;
          try {
            await this.BleManager.stopNotification(
              peripheralId,
              serviceUUID,
              characteristicUUID
            );
            this.addLog(`Stopped notifications for actions characteristic`);
          } catch (error) {
            this.addLog(
              `Attemped to stop notifications for [actions] characteristic: ${
                error?.message ?? error
              }`
            );
          }
        }
      })
    );

    selectedDevice$
      .pipe(
        switchMap((selectedDevice: DeviceInfo) =>
          !osHasBluetoothSupport(selectedDevice) ? EMPTY : sideEffects$
        )
      )
      .subscribe();
  }

  async dispatchAction({
    characteristicName,
    action
  }: ActionOptions): Promise<any> {
    const {
      responseRequired = false,
      responseTimeout = DEFAULT_ACTION_RESPONSE_TIMEOUT
    } = action;

    return new Promise(async (resolve, reject) => {
      const actionId: number = create6DigitPin(); // use to later identify and filter response
      const payload = JSON.stringify({ actionId, ...action }); // add the response id to the action

      this.addLog(`Dispatched action with id ${actionId}`);

      if (responseRequired && responseTimeout) {
        this._addPendingAction(actionId);

        const timeout = timer(responseTimeout).subscribe(() => {
          this._removePendingAction(actionId);
          reject(
            `Action with id ${actionId} timed out after ${responseTimeout}ms`
          );
        });

        // listen for a response before writing
        this.subscribeToCharacteristic({
          characteristicName,
          manageNotifications: false
        })
          .pipe(
            filter((response: any) => response?.actionId === actionId),
            take(1)
          )
          .subscribe((response) => {
            timeout.unsubscribe();
            this._removePendingAction(actionId);
            resolve(response);
          });

        // register action by writing
        this.writeCharacteristic(characteristicName, payload).catch((error) => {
          this._removePendingAction(actionId);
          reject(error.message);
        });
      } else {
        this.writeCharacteristic(characteristicName, payload)
          .then(() => {
            resolve(null);
          })
          .catch((error) => {
            reject(error.message);
          });
      }
    });
  }
}
