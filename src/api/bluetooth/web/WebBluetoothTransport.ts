import { BLUETOOTH_PRIMARY_SERVICE_UUID_HEX } from "@neurosity/ipk";
import { BLUETOOTH_CHUNK_DELIMITER } from "@neurosity/ipk";
import { BLUETOOTH_DEVICE_NAME_PREFIXES } from "@neurosity/ipk";
import { BLUETOOTH_COMPANY_IDENTIFIER_HEX } from "@neurosity/ipk";
import { BehaviorSubject, defer, firstValueFrom, Subject, timer } from "rxjs";
import { fromEventPattern, Observable, NEVER } from "rxjs";
import { switchMap, map, filter } from "rxjs/operators";
import { shareReplay, distinctUntilChanged } from "rxjs/operators";
import { take, share } from "rxjs/operators";

import { BluetoothTransport } from "../BluetoothTransport";
import { isWebBluetoothSupported } from "./isWebBluetoothSupported";
import { create6DigitPin } from "../utils/create6DigitPin";
import { stitchChunks } from "../utils/stitch";
import { encode, decode } from "../utils/encoding";
import { ActionOptions, SubscribeOptions } from "../types";
import { TRANSPORT_TYPE, STATUS } from "../types";
import { DEFAULT_ACTION_RESPONSE_TIMEOUT } from "../constants";
import { CHARACTERISTIC_UUIDS_TO_NAMES } from "../constants";

export class WebBluetoothTransport implements BluetoothTransport {
  type: TRANSPORT_TYPE = TRANSPORT_TYPE.WEB;
  device: BluetoothDevice;
  server: BluetoothRemoteGATTServer;
  service: BluetoothRemoteGATTService;
  characteristicsByName: {
    [name: string]: BluetoothRemoteGATTCharacteristic;
  } = {};

  status$ = new BehaviorSubject<STATUS>(STATUS.DISCONNECTED);
  autoReconnectEnabled$ = new BehaviorSubject<boolean>(true);
  pendingActions$ = new BehaviorSubject<any[]>([]);
  logs$ = new Subject<string>();
  onDisconnected$: Observable<void> = this._onDisconnected().pipe(share());
  connectionStatus$: Observable<STATUS> = this.status$.asObservable().pipe(
    filter((status) => !!status),
    distinctUntilChanged(),
    shareReplay(1)
  );

  constructor() {
    if (!isWebBluetoothSupported()) {
      const errorMessage = "Web Bluetooth is not supported";
      this.addLog(errorMessage);
      throw new Error(errorMessage);
    }

    this.status$.asObservable().subscribe((status) => {
      this.addLog(`status is ${status}`);
    });

    this.onDisconnected$.subscribe(() => {
      this.status$.next(STATUS.DISCONNECTED);
    });

    this.onDisconnected$.subscribe(() => {
      // only auto-reconnect if disconnected action not started by the user
      if (this.autoReconnectEnabled$.getValue()) {
        // this.addLog(`Attempting to reconnect...`);
        //this.getServerServiceAndCharacteristics();
      }
    });

    this._autoToggleActionNotifications();

    this._autoConnect("Crown-85A").catch((error) => {
      console.log(error);
      this.addLog(`Auto connect: error -> ${error?.message ?? error}`);
    });
  }

  async _autoConnect(deviceNickname: string): Promise<void> {
    try {
      const [devicesError, devices] = await navigator.bluetooth
        .getDevices()
        .then((devices) => [null, devices])
        .catch((error) => [error, null]);

      if (devicesError) {
        throw new Error(
          `failed to get devices: ${devicesError?.message ?? devicesError}`
        );
      }

      this.addLog(
        `Auto connect: found ${devices.length} devices ${devices
          .map(({ name }) => name)
          .join(", ")}`
      );

      const device: BluetoothDevice | undefined = devices.find(
        (device: BluetoothDevice) => device.name === deviceNickname
      );

      if (!device) {
        throw new Error(
          `couldn't find selected device in the list of paired devices.`
        );
      }

      this.addLog(
        `Auto connect: ${deviceNickname} was detected and previously paired`
      );

      const abortController = new AbortController();
      const { signal } = abortController;

      fromDOMEvent(device, "advertisementreceived")
        .pipe(take(1))
        .subscribe((event) => {
          this.addLog(`Advertisement received for ${event.device.name}`);

          abortController.abort();

          this.getServerServiceAndCharacteristics(device).catch((error) => {
            throw error;
          });
        });

      await device.watchAdvertisements({ signal });
    } catch (error) {
      return Promise.reject(new Error(error));
    }
  }

  addLog(log: string) {
    this.logs$.next(log);
  }

  isConnected() {
    const status = this.status$.getValue();
    return status === STATUS.CONNECTED;
  }

  connectionStatus(): Observable<STATUS> {
    return this.connectionStatus$;
  }

  async connect(deviceNickname?: string): Promise<void> {
    try {
      // requires user gesture
      const device: BluetoothDevice = await this.requestDevice(deviceNickname);

      await this.getServerServiceAndCharacteristics(device);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async requestDevice(deviceNickname?: string): Promise<BluetoothDevice> {
    try {
      this.addLog("Requesting Bluetooth Device...");

      const prefixes = BLUETOOTH_DEVICE_NAME_PREFIXES.map((namePrefix) => ({
        namePrefix
      }));

      // Ability to only show selectedDevice if provided
      const filters = deviceNickname
        ? [
            {
              name: deviceNickname
            }
          ]
        : prefixes;

      const device = await window.navigator.bluetooth.requestDevice({
        filters: [
          ...filters,
          {
            manufacturerData: [
              {
                companyIdentifier: BLUETOOTH_COMPANY_IDENTIFIER_HEX
              }
            ]
          }
        ],
        optionalServices: [BLUETOOTH_PRIMARY_SERVICE_UUID_HEX]
      });

      return device;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getServerServiceAndCharacteristics(device: BluetoothDevice) {
    try {
      this.device = device;

      this.status$.next(STATUS.CONNECTING);

      this.server = await device.gatt.connect();

      this.addLog(`Getting service...`);
      this.service = await this.server.getPrimaryService(
        BLUETOOTH_PRIMARY_SERVICE_UUID_HEX
      );
      this.addLog(
        `Got service ${this.service.uuid}, getting characteristics...`
      );

      const characteristicsList = await this.service.getCharacteristics();

      this.addLog(`Got characteristics`);

      this.characteristicsByName = Object.fromEntries(
        characteristicsList.map((characteristic) => [
          CHARACTERISTIC_UUIDS_TO_NAMES[characteristic.uuid],
          characteristic
        ])
      );

      this.status$.next(STATUS.CONNECTED);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  _onDisconnected(): Observable<any> {
    return this.status$.asObservable().pipe(
      switchMap((status) =>
        status === STATUS.CONNECTED
          ? fromEventPattern(
              (addHandler) => {
                this.device.addEventListener(
                  "gattserverdisconnected",
                  addHandler
                );
              },
              (removeHandler) => {
                this.device.removeEventListener(
                  "gattserverdisconnected",
                  removeHandler
                );
              }
            )
          : NEVER
      )
    );
  }

  async disconnect(): Promise<void> {
    const isDeviceConnected = this?.device?.gatt?.connected;
    if (isDeviceConnected) {
      this.autoReconnectEnabled$.next(false);
      this.device.gatt.disconnect();
      this.autoReconnectEnabled$.next(true);
    }
  }

  /**
   *
   * Bluetooth GATT attributes, services, characteristics, etc. are invalidated
   * when a device disconnects. This means your code should always retrieve
   * (through getPrimaryService(s), getCharacteristic(s), etc.) these attributes
   * after reconnecting.
   */
  async getCharacteristicByName(
    characteristicName: string
  ): Promise<BluetoothRemoteGATTCharacteristic> {
    return this.characteristicsByName?.[characteristicName];
  }

  subscribeToCharacteristic({
    characteristicName,
    manageNotifications = true
  }: SubscribeOptions): Observable<any> {
    const data$ = defer(() =>
      this.getCharacteristicByName(characteristicName)
    ).pipe(
      switchMap(async (characteristic: BluetoothRemoteGATTCharacteristic) => {
        if (this.isConnected() && manageNotifications) {
          try {
            await characteristic.startNotifications();
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

        return characteristic;
      }),
      switchMap((characteristic: BluetoothRemoteGATTCharacteristic) => {
        return fromEventPattern(
          (addHandler) => {
            characteristic.addEventListener(
              "characteristicvaluechanged",
              addHandler
            );
          },
          async (removeHandler) => {
            if (this.isConnected() && manageNotifications) {
              try {
                await characteristic.stopNotifications();
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

            characteristic.removeEventListener(
              "characteristicvaluechanged",
              removeHandler
            );
          }
        );
      }),
      map((event: any): string => {
        const buffer: Uint8Array = event.target.value;
        // this.addLog(
        //   `Received chunk for ${characteristicName} characteristic: \n${decode(
        //     this.type,
        //     buffer
        //   )}`
        // );

        return decode(this.type, buffer);
      }),
      stitchChunks({ delimiter: BLUETOOTH_CHUNK_DELIMITER }),
      map((payload: any) => {
        try {
          return JSON.parse(payload);
        } catch (_) {
          return payload;
        }
      })
      // when streaming at ultra-low latency, the logs will slow down rendering
      // tap((data) => {
      //   this.addLog(
      //     `Received data for ${characteristicName} characteristic: \n${JSON.stringify(
      //       data,
      //       null,
      //       2
      //     )}`
      //   );
      // })
    );

    return this.status$.pipe(
      switchMap((status) => (status === STATUS.CONNECTED ? data$ : NEVER))
    );
  }

  async readCharacteristic(
    characteristicName: string,
    parse: boolean = false
  ): Promise<any> {
    try {
      this.addLog(`Reading characteristic: ${characteristicName}`);

      const characteristic: BluetoothRemoteGATTCharacteristic =
        await this.getCharacteristicByName(characteristicName);

      if (!characteristic) {
        this.addLog(`Did not fund ${characteristicName} characteristic`);

        return Promise.reject(
          `Did not find characteristic by the name: ${characteristicName}`
        );
      }

      const value: unknown = await characteristic.readValue();
      const uint8Array = value as Uint8Array;
      const decodedValue: string = decode(this.type, uint8Array);
      const data = parse ? JSON.parse(decodedValue) : decodedValue;

      this.addLog(
        `Received read data from ${characteristicName} characteristic: \n${data}`
      );

      return data;
    } catch (error) {
      return Promise.reject(`Error reading characteristic: ${error.message}`);
    }
  }

  async writeCharacteristic(
    characteristicName: string,
    data: string
  ): Promise<void> {
    this.addLog(`Writing characteristic: ${characteristicName}`);

    const characteristic: BluetoothRemoteGATTCharacteristic =
      await this.getCharacteristicByName(characteristicName);

    if (!characteristic) {
      this.addLog(`Did not fund ${characteristicName} characteristic`);

      return Promise.reject(
        `Did not find characteristic by the name: ${characteristicName}`
      );
    }

    const encoded = encode(this.type, data);

    await characteristic.writeValueWithResponse(encoded as Uint8Array);
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

  async _autoToggleActionNotifications() {
    let actionsCharacteristic: BluetoothRemoteGATTCharacteristic;
    let started: boolean = false;

    this.status$
      .asObservable()
      .pipe(
        switchMap((status) =>
          status === STATUS.CONNECTED
            ? defer(() => this.getCharacteristicByName("actions")).pipe(
                switchMap(
                  (characteristic: BluetoothRemoteGATTCharacteristic) => {
                    actionsCharacteristic = characteristic;
                    return this.pendingActions$;
                  }
                )
              )
            : NEVER
        )
      )
      .subscribe(async (pendingActions: string[]) => {
        const hasPendingActions = !!pendingActions.length;

        if (hasPendingActions && !started) {
          started = true;
          try {
            await actionsCharacteristic.startNotifications();
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
            await actionsCharacteristic.stopNotifications();
            this.addLog(`Stopped notifications for actions characteristic`);
          } catch (error) {
            this.addLog(
              `Attemped to stop notifications for [actions] characteristic: ${
                error?.message ?? error
              }`
            );
          }
        }
      });
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
      const characteristic: BluetoothRemoteGATTCharacteristic | void =
        await this.getCharacteristicByName(characteristicName).catch(() => {
          reject(
            `Did not find characteristic by the name: ${characteristicName}`
          );
        });

      if (!characteristic) {
        return;
      }

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

function fromDOMEvent(target: any, eventName: any): Observable<any> {
  return fromEventPattern(
    (addHandler) => {
      target.addEventListener(eventName, addHandler);
    },
    (removeHandler) => {
      target.removeEventListener(eventName, removeHandler);
    }
  );
}
