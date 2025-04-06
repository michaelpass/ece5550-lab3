// ==================================================
//         ECE:5550 - Internet of Things          |
//         Prof. Tyler Bell                       |
//         Michael Pass, Cody Allison (Group 8A)  |
//         Lab 03                                 |
// ==================================================

require('dotenv').config();
var nodeimu = require('@trbll/nodeimu');
var IMU = new nodeimu.IMU();
var sense = require('@trbll/sense-hat-led');
const { getDatabase, ref, onValue, set, update, get } = require('firebase/database');
const { getAuth, signInAnonymously } = require('firebase/auth');
const { initializeApp } = require('firebase/app');

var interval = 1000; // Default interval
var currentIntervalID = null;

const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: "ece5550-lab2.firebaseapp.com",
    projectId: "ece5550-lab2",
    storageBucket: "ece5550-lab2.firebasestorage.app",
    messagingSenderId: "235255244041",
    appId: "1:235255244041:web:68ecb079d72bf2ca461fd8",
    measurementId: "G-CGG2YSDLBP"
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const auth = getAuth(app);

const stateRef = ref(database, 'state');
const updateLightRef = ref(database, 'state/update_light');
const intervalRef = ref(database, 'state/Interval');
const lightInfoRef = ref(database, 'state/light_info');

const { createBluetooth } = require('node-ble');

const ARDUINO_BLUETOOTH_ADDR = 'E9:24:FA:43:49:F8';
const UART_SERVICE_UUID = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E';
const TX_CHARACTERISTIC_UUID = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E';
const RX_CHARACTERISTIC_UUID = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E';
const EES_SERVICE_UUID = '0000181a-0000-1000-8000-00805f9b34fb';
const TEMP_CHAR_UUID = '00002a6e-0000-1000-8000-00805f9b34fb';

let txChar;
let device;
let isConnected = false;

function startUpdateLightListener() {
    onValue(updateLightRef, async (snapshot) => {
        const updateLightValue = snapshot.val();
        console.log('update_light changed to:', updateLightValue);
        if (updateLightValue) {
            try {
                const lightInfoSnapshot = await get(lightInfoRef);
                const lightInfo = lightInfoSnapshot.val();
                console.log('Light changed:');
                console.log("Row: ", lightInfo.light_row, " Col: ", lightInfo.light_col);
                console.log("R: ", lightInfo.light_r, " G: ", lightInfo.light_g, " B: ", lightInfo.light_b);
                sense.setPixel(
                    lightInfo.light_row,
                    lightInfo.light_col,
                    [lightInfo.light_r, lightInfo.light_g, lightInfo.light_b]
                );
            } catch (error) {
                console.error('Error fetching light_info:', error);
            }
        }
    }, (error) => {
        console.error('Error listening to update_light:', error);
    });
}

function startIntervalListener() {
    onValue(intervalRef, async (snapshot) => {
        let updateIntervalValue = snapshot.val();
        console.log('Interval changed to:', updateIntervalValue);
        updateIntervalValue = parseFloat(updateIntervalValue);
        const intervalInSeconds = updateIntervalValue;
        updateIntervalValue = 1000 * updateIntervalValue;
        if (updateIntervalValue < 1000) {
            updateIntervalValue = 1000;
        }
        if (updateIntervalValue > 10000) {
            updateIntervalValue = 10000;
        }
        console.log('Interval changed to: ', intervalInSeconds, 's');
        if (txChar && isConnected) {
            const message = `interval:${intervalInSeconds}`;
            try {
                await txChar.writeValue(Buffer.from(message));
                console.log('Sent over BLE:', message);
            } catch (error) {
                console.error('Error writing to TX characteristic:', error);
            }
        } else {
            console.warn('txChar is not defined or not connected. Cannot send interval message.');
        }
        interval = updateIntervalValue;
        startSensorUpdates(interval);
    }, (error) => {
        console.error('Error listening to Interval:', error);
    });
}

async function updateSensorReadings() {
    try {
        const data = IMU.getValueSync();
        if (!data || typeof data !== 'object') {
            throw new Error('IMU data is not an object or is undefined');
        }
        const humidity = Number(data.humidity || 0).toFixed(2);
        console.log('Humidity: ' + humidity + ' %');
        const updates = {
            humidity: parseFloat(humidity)
        };
        await update(stateRef, updates);
    } catch (error) {
        console.error('Error getting IMU data:', error);
    }
}

function startSensorUpdates(set_interval) {
    if (currentIntervalID === null) {
        currentIntervalID = setInterval(updateSensorReadings, set_interval);
    } else {
        clearInterval(currentIntervalID);
        currentIntervalID = setInterval(updateSensorReadings, set_interval);
    }
}

async function startApp() {
    try {
        const userCredential = await signInAnonymously(auth);
        console.log('User signed in:', userCredential.user.uid);
        startUpdateLightListener();
        startSensorUpdates(interval);
    } catch (error) {
        console.error('Error signing in:', error);
    }
}

async function connectToDevice(adapter, destroy) {
    while (true) { // Infinite loop for reconnection
        try {
            if (!isConnected) {
                console.log('discovering...');
                device = await adapter.waitDevice(ARDUINO_BLUETOOTH_ADDR.toUpperCase());
                console.log('found device. attempting connection...');
                await device.connect();
                console.log('connected to device!');
                isConnected = true;

                const gattServer = await device.gatt();
                const uartService = await gattServer.getPrimaryService(UART_SERVICE_UUID.toLowerCase());
                txChar = await uartService.getCharacteristic(TX_CHARACTERISTIC_UUID.toLowerCase());
                const rxChar = await uartService.getCharacteristic(RX_CHARACTERISTIC_UUID.toLowerCase());
                const eesService = await gattServer.getPrimaryService(EES_SERVICE_UUID.toLowerCase());
                const tempChar = await eesService.getCharacteristic(TEMP_CHAR_UUID.toLowerCase());

                // Fetch and send initial Interval
                try {
                    const intervalSnapshot = await get(intervalRef);
                    let initialInterval = intervalSnapshot.val();
                    initialInterval = parseFloat(initialInterval) || 1;
                    if (initialInterval < 1) initialInterval = 1;
                    if (initialInterval > 10) initialInterval = 10;
                    const msInterval = initialInterval * 1000;
                    const message = `interval:${initialInterval}`; // Send in seconds
                    await txChar.writeValue(Buffer.from(message));
                    console.log('Initial interval sent over BLE:', message);
                    interval = msInterval;
                    startSensorUpdates(interval);
                } catch (error) {
                    console.error('Error fetching initial Interval:', error);
                    const message = `interval:1`;
                    await txChar.writeValue(Buffer.from(message));
                    console.log('Sent fallback interval over BLE:', message);
                    interval = 1000;
                    startSensorUpdates(interval);
                }

                await rxChar.startNotifications();
                rxChar.on('valuechanged', buffer => {
                    console.log('Received: ' + buffer.toString());
                });

                await tempChar.startNotifications();
                tempChar.on('valuechanged', async buffer => {
                    if (buffer.length !== 2) {
                        console.error('Temperature data buffer is not 2 bytes long', buffer.length);
                        return;
                    }
                    const tempRaw = (buffer[1] << 8) | buffer[0];
                    const tempC = tempRaw / 100.0;
                    console.log('Temperature: ' + tempC.toFixed(2) + ' °C');
                    try {
                        await update(stateRef, { temperature: tempC });
                    } catch (error) {
                        console.error('Error updating temperature to Firebase:', error);
                    }
                });

                // Handle disconnection
                device.on('disconnect', async () => {
                    console.log('Device disconnected');
                    isConnected = false;
                    txChar = null; // Clear characteristic to avoid stale references
                });
            }
        } catch (error) {
            console.error('Connection error:', error);
            isConnected = false;
            if (device) await device.disconnect().catch(() => {}); // Clean up if possible
        }

        // Wait before retrying if not connected
        if (!isConnected) {
            console.log('Retrying connection in 5 seconds...');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

async function main() {
    await startApp();

    const { bluetooth, destroy } = createBluetooth();
    const adapter = await bluetooth.defaultAdapter();
    await adapter.startDiscovery();

    // Start connection loop
    connectToDevice(adapter, destroy);

    // Handle manual exit
    const stdin = process.openStdin();
    stdin.addListener('data', async function(d) {
        let inStr = d.toString().trim();
        if (inStr === 'exit') {
            console.log('disconnecting...');
            if (device && isConnected) await device.disconnect();
            console.log('disconnected.');
            destroy();
            process.exit();
        }
        inStr = (inStr.length > 20) ? inStr.slice(0, 20) : inStr;
        if (txChar && isConnected) {
            await txChar.writeValue(Buffer.from(inStr)).then(() => {
                console.log('Sent: ' + inStr);
            }).catch(err => {
                console.error('Error writing to TX characteristic:', err);
            });
        }
    });

    // Start interval listener after initial setup
    startIntervalListener();
}

main().then((ret) => {
    if (ret) console.log(ret);
}).catch((err) => {
    if (err) console.error(err);
});