import StackTraceGPS from 'stacktrace-gps';
import {APP_ID, PLAYER_ID, SUBDOMAIN} from './vars.js';
import chai, { expect } from 'chai';
import StackTrace from 'stacktrace-js';
import IndexedDb from '../src/indexedDb';
import { executeAndTimeoutPromiseAfter } from '../src/utils';


// URLSearchParams.toString() does a second weird URL encoding so here we have to redo the URL encoding
export default class Utils {
    static urlSearchParamToString(params) {
        let string = '?';
        for (let entry of params.entries()) {
            string += `&${entry[0]}=${entry[1]}`
        }
        return string;
    }

    /**
     * Given a JavaScript error object, returns a more precise error using source maps.
     */
    static captureError(e) {
        if (typeof(e) === 'string') {
            // This is not an actual Error object, so just return t he error
            return Promise.resolve(e);
        }
        return StackTrace.fromError(e)
            .then(stackFrame => {
                stackFrame = stackFrame[0];
                let gps = new StackTraceGPS();
                if (stackFrame.fileName) {
                    stackFrame.fileName = stackFrame.fileName.replace('https://127.0.0.1:3001/', location.origin + '/');
                }
                if (stackFrame.source) {
                    stackFrame.source = stackFrame.source.replace('https://127.0.0.1:3001/', location.origin + '/');
                }
                return gps.pinpoint(stackFrame);
            })
            .then(detailedError => {
                if (detailedError.fileName) {
                    detailedError.fileName = detailedError.fileName.replace('webpack:///', 'webpack:///./');
                }
                return `${e.name}: ${e.message} @ ${detailedError.fileName}:${detailedError.lineNumber}:${detailedError.columnNumber}`;
            })
            .catch(x => {
                if (!Utils.recursiveDepth) {
                    Utils.recursiveDepth = 0;
                }
                if (Utils.recursiveDepth < 3) {
                    Utils.recursiveDepth++;
                    return Utils.captureError(x);
                }
            });
    }

    /**
     * Wipe OneSignal-related IndexedDB data.
     */
    static wipeIndexedDb() {
        return Promise.all([
            IndexedDb.remove('Ids'),
            IndexedDb.remove('NotificationOpened'),
            IndexedDb.remove('Options')
        ]);
    }

    /**
     * Unsubscribe from push notifications and remove the service worker.
     */
    static wipeServiceWorkerAndUnsubscribe() {
        if (!navigator.serviceWorker || !navigator.serviceWorker.controller)
            return Promise.resolve();

        let unsubscribePromise = navigator.serviceWorker.ready
            .then(registration => registration.pushManager)
            .then(pushManager => pushManager.getSubscription())
            .then(subscription => {
                if (subscription) {
                    return subscription.unsubscribe();
                }
            });

        let unregisterWorkerPromise = navigator.serviceWorker.ready
            .then(registration => registration.unregister());

        return Promise.all([
            unsubscribePromise,
            unregisterWorkerPromise
        ]);
    }

    /**
     * Gets the sequence of calls to initialize / subscribe for the HTTP / HTTPS test site.
     * @param options Use 'autoRegister' or 'welcomeNotification'.
     */
    static initialize(options) {
        if (!options) {
            options = {};
        }
        return Promise.all([
                // Wipe database and force allow notifications permission for current site origin
                Extension.setNotificationPermission(`${location.origin}/*`, 'allow'),
                // Also allow popup permissions (only for HTTP, but doesn't hurt to enable for HTTPS)
                Extension.setPopupPermission(`${location.origin}/*`, 'allow'),
                // Only for HTTPS: Wipes the IndexedDB on the current site origin
                options.dontWipeData ? null : Utils.wipeIndexedDb(),
                options.dontWipeData ? null : Utils.wipeServiceWorkerAndUnsubscribe()
            ])
            .then(() => {
                // Initialize OneSignal and subscribe
                return new Promise(resolve => {
                    window.OneSignal = OneSignal || [];
                    OneSignal.push(function () {
                        OneSignal.LOGGING = true;
                        let initOptions = {
                            appId: APP_ID,
                            autoRegister: options.autoRegister,
                            persistNotification: false,
                            dangerouslyWipeData: true && location.protocol === 'http:' && !options.dontWipeData // Wipes IndexedDB data on popup / iframe initialize for HTTP
                        };
                        if (!options.welcomeNotification) {
                            initOptions.welcomeNotification = {
                                disable: true
                            }
                        }
                        if (options.notifyButton) {
                            initOptions.notifyButton = {
                                enable: true
                            };
                        }
                        if (location.protocol === 'http:') {
                            initOptions.subdomainName = SUBDOMAIN;
                            if (options.autoRegister) {
                                OneSignal.registerForPushNotifications();
                            }
                        }
                        OneSignal.push(["init", initOptions]);

                        if (options.autoRegister) {
                            if (location.protocol === 'http:') {
                                // Wait for the HTTP popup to appear and be interactable
                                OneSignal.on('popupLoad', resolve);
                            } else {
                                if (options.dontWipeData) {
                                    // There will be no subscriptionChange event since data wasn't wiped, but user
                                    // autoregistered anyways, so continue on
                                    resolve();
                                } else {
                                    // Wait for the HTTPS subscription to finish
                                    OneSignal.on('subscriptionChange', resolve);
                                }
                            }
                        } else {
                            // Don't subscribe, just wait for SDK to initialize
                            OneSignal.on('initialize', resolve);
                        }
                    });
                });
            })
            .then(() => {
                if (location.protocol === 'http:' && options.autoRegister) {
                    return Extension.acceptHttpSubscriptionPopup();
                }
            })
            .then(() => {
                if (location.protocol === 'http:' && options.autoRegister) {
                    return new Promise(resolve => {
                        OneSignal.on('subscriptionChange', resolve);
                    });
                }
            })
    }

    static expectEvent(eventName, timeout) {
        if (!timeout) {
            timeout = 10000;
        }
        return executeAndTimeoutPromiseAfter(new Promise(resolve => {
            OneSignal.once(eventName, resolve);
        }).catch(e => console.error(e)), timeout, `Event '${eventName}' did not fire after ${timeout} ms.`);
    }

    static wait(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    static deletePlayer(userId) {
        return Utils.httpCall('DELETE', `https://${location.hostname}:8080/player/${userId}`);
    }

    static httpCall(method, endpoint, data, headers, options) {
        let callHeaders = new Headers();
        callHeaders.append('Content-Type', 'application/json;charset=UTF-8');
        if (headers) {
            for (let key of Object.keys(headers)) {
                callHeaders.append(key, headers[key]);
            }
        }

        let contents = Object.assign({
            method: method || 'NO_METHOD_SPECIFIED',
            headers: callHeaders,
            cache: 'no-cache'
        }, options);
        if (data)
            contents.body = JSON.stringify(data);

        var status;
        return fetch(endpoint, contents)
            .then(response => {
                status = response.status;
                return response.json();
            })
            .then(json => {
                if (status >= 200 && status < 300)
                    return json;
                else {
                    return Promise.reject(json);
                }
            });
    }
}