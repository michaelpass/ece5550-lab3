// ==================================================
//         ECE:5550 - Internet of Things           
//         Prof. Tyler Bell                        
//         Michael Pass, Cody Allison (Group 8A)   
//         Lab 03                                  
// ==================================================

require('dotenv').config();
var nodeimu = require('@trbll/nodeimu');
var IMU = new nodeimu.IMU();
var sense = require('@trbll/sense-hat-led');

// These imports let us interact with Firebase's Realtime Database
const { getDatabase, ref, onValue, set, update, get } = require('firebase/database');
const { getAuth, signInAnonymously } = require('firebase/auth');
const { initializeApp } = require('firebase/app');

// Catch any unhandled exceptions/rejections to prevent crashes
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', (error) => console.error('Uncaught Exception:', error));

// Default interval in milliseconds (for Pi-based sensor readings)
var interval = 1000; 
var currentIntervalID = null;

// Firebase config from .env plus static details
const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: "ece5550-lab2.firebaseapp.com",
    projectId: "ece5550-lab2",
    storageBucket: "ece5550-lab2.firebasestorage.app",
    messagingSenderId: "235255244041",
    appId: "1:235255244041:web:68ecb079d72bf2ca461fd8",
    measurementId: "G-CGG2YSDLBP"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const auth = getAuth(app);

// References to Firebase database nodes
const stateRef = ref(database, 'state');
const updateLightRef = ref(database, 'state/update_light');
// Below is the reference to "Interval" for controlling sensor rate
const intervalRef = ref(database, 'state/Interval');
const lightInfoRef = ref(database, 'state/light_info');

// Import the BLE library
const { createBluetooth } = require('node-ble');

// The Arduino's BLE address and the relevant service/characteristic UUIDs
const ARDUINO_BLUETOOTH_ADDR = '84:AE:B1:33:8A:87';
const UART_SERVICE_UUID = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E';     
const TX_CHARACTERISTIC_UUID = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E'; 
const RX_CHARACTERISTIC_UUID = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E'; 
const EES_SERVICE_UUID = '0000181a-0000-1000-8000-00805f9b34fb';     
const TEMP_CHAR_UUID = '00002a6e-0000-1000-8000-00805f9b34fb';

// Variables for the BLE connection and characteristic references
let txChar;          // Will hold the TX characteristic for sending data to Arduino
let device;          // The BLE device reference
let isConnected = false; // Tracks if we're currently connected over BLE

/**
 * Listens for changes to "update_light" in Firebase,
 * and if true, updates the Sense Hat LED accordingly.
 */
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

/**
 * Listen for Interval changes in Firebase. 
 * When changed:
 *   1) Convert it to milliseconds (bounded by 1s - 10s).
 *   2) Send that new interval to the Arduino over BLE.
 *   3) Restart the Pi's local sensor updates at that new interval.
 */
function startIntervalListener() {
    onValue(intervalRef, async (snapshot) => {
        let updateIntervalValue = snapshot.val();    
        console.log('Interval changed to:', updateIntervalValue);

        // Convert the stored Interval (seconds) to a float
        updateIntervalValue = parseFloat(updateIntervalValue);

        // Just note for reference; 'intervalInSeconds' may or may not be used
        const intervalInSeconds = updateIntervalValue;  

        // Convert from seconds to milliseconds
        updateIntervalValue = 1000 * updateIntervalValue; 

        // Bound the interval to [1 second..10 seconds] in ms
        if (updateIntervalValue < 1000) updateIntervalValue = 1000;    
        if (updateIntervalValue > 10000) updateIntervalValue = 10000;

        // If we're connected over BLE and have the TX characteristic,
        // send the new interval to the Arduino (so it can adjust accordingly)
        if (txChar && isConnected) {
            const message = `interval:${updateIntervalValue}`;
            try {
                await txChar.writeValue(Buffer.from(message));
                console.log('Sent over BLE:', message);
            } catch (error) {
                console.error('Error writing to TX characteristic:', error);
            }
        } else {
            console.warn('txChar is not defined or not connected. Cannot send interval message.');
        }

        // Update the Pi's local 'interval' variable and restart the sensor updates
        interval = updateIntervalValue;
        startSensorUpdates(interval);
    }, (error) => {
        console.error('Error listening to Interval:', error);
    });
}

/**
 * Reads humidity from Sense Hat (IMU) and updates the "state" node in Firebase.
 * Does NOT read or push temperature; that is provided by the Arduino via BLE.
 */
async function updateSensorReadings() {
    try {
        const data = IMU.getValueSync();
        if (!data || typeof data !== 'object') {
            throw new Error('IMU data is not an object or is undefined');
        }
        const humidity = Number(data.humidity || 0).toFixed(2);
        console.log('Humidity measured: ' + humidity + ' %');
        await update(stateRef, { humidity: parseFloat(humidity) });
    } catch (error) {
        console.error('Error getting IMU data:', error);
    }
}

/**
 * (Re)start the timer that calls updateSensorReadings() at the specified interval (ms).
 */
function startSensorUpdates(set_interval) {
    if (currentIntervalID === null) {
        currentIntervalID = setInterval(updateSensorReadings, set_interval);
    } else {
        clearInterval(currentIntervalID);
        currentIntervalID = setInterval(updateSensorReadings, set_interval);
    }
}

/**
 * Sign into Firebase anonymously, start the two main listeners 
 * (light updates + interval changes), and begin sensor updates on the Pi.
 */
async function startApp() {
    try {
        const userCredential = await signInAnonymously(auth);
        console.log('User signed in:', userCredential.user.uid);
        startUpdateLightListener();
        startIntervalListener();
        startSensorUpdates(interval);
    } catch (error) {
        console.error('Error signing in:', error);
    }
}

/**
 * Fetch the initial interval from Firebase and send it to Arduino over BLE,
 * in case the Pi wasn't connected when the last Interval was set.
 */
async function sendInitialInterval() {
    try {
        const intervalSnapshot = await get(intervalRef);
        let initialInterval = intervalSnapshot.val();
        initialInterval = parseFloat(initialInterval) || 1;

        // Enforce range 1..10
        if (initialInterval < 1) initialInterval = 1;
        if (initialInterval > 10) initialInterval = 10;

        // Convert from seconds to milliseconds
        const msInterval = initialInterval * 1000;
        const message = `interval:${msInterval}`;

        // Send that interval to the Arduino over BLE
        await txChar.writeValue(Buffer.from(message));
        console.log('Initial interval sent over BLE:', message);

        // Also locally store and begin Pi sensor updates at that rate
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
}

/**
 * Continuously tries to connect (and stay connected) to the Arduino via BLE.
 * Once connected, we set up:
 *   - TX characteristic for sending data (the 'interval:xxxx' messages),
 *   - RX characteristic for receiving data,
 *   - Temperature characteristic for receiving the Arduino's temperature,
 *   - any disconnect handlers to retry when the Arduino goes away.
 */
async function connectToDevice(adapter, destroy) {
    while (true) {
        try {
            if (!isConnected) {
                console.log('discovering...');
                // Wait until we find a device with the matching address
                device = await adapter.waitDevice(ARDUINO_BLUETOOTH_ADDR.toUpperCase());
                console.log('found device. attempting connection...');
                await device.connect();
                console.log('connected to device!');
                isConnected = true;

                const gattServer = await device.gatt();
                console.log('GATT server acquired');
                // Get the Nordic UART service
                const uartService = await gattServer.getPrimaryService(UART_SERVICE_UUID.toLowerCase());
                // TX characteristic for writing to Arduino
                txChar = await uartService.getCharacteristic(TX_CHARACTERISTIC_UUID.toLowerCase());
                // RX characteristic for receiving data from Arduino
                const rxChar = await uartService.getCharacteristic(RX_CHARACTERISTIC_UUID.toLowerCase());
                // Environmental Sensing Service (ESS) + temperature characteristic
                const eesService = await gattServer.getPrimaryService(EES_SERVICE_UUID.toLowerCase());
                const tempChar = await eesService.getCharacteristic(TEMP_CHAR_UUID.toLowerCase());

                console.log('Starting RX notifications');
                // Listen for any data from the Arduino over the RX characteristic
                await rxChar.startNotifications();
                rxChar.on('valuechanged', buffer => {
                    console.log('RX Received: ' + buffer.toString());
                });

                console.log('Starting temperature notifications');
                // Listen for temperature data from the Arduino
                await tempChar.startNotifications();
                tempChar.on('valuechanged', buffer => {
                    if (buffer.length !== 2) {
                        console.error('Temperature data buffer is not 2 bytes long', buffer.length);
                        return;
                    }
                    // Parse the short integer from buffer
                    const tempRaw = (buffer[1] << 8) | buffer[0];
                    const tempC = tempRaw / 100.0;
                    console.log('Temperature received: ' + tempC.toFixed(2) + ' °C');
                    // Update Firebase with the Arduino's temperature
                    update(stateRef, { temperature: tempC });
                });

                console.log('Sending initial interval');
                await sendInitialInterval();
                console.log('Initial interval sent successfully');

                // If the Arduino disconnects, we set isConnected = false and retry
                device.on('disconnect', async () => {
                    console.log('Device disconnected');
                    isConnected = false;
                    txChar = null;
                });
            }
            // Wait a short while before we do the next loop iteration
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            console.error('Connection error:', error.message);
            isConnected = false;
            if (device) await device.disconnect().catch(() => {});
        }

        // If not connected, wait 5s and try connecting again
        if (!isConnected) {
            console.log('Retrying connection in 5 seconds...');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

/**
 * Main entry point. Signs into Firebase, starts BLE discovery, 
 * attempts to connect to the Arduino, and listens for console input commands.
 */
async function main() {
    await startApp();

    const { bluetooth, destroy } = createBluetooth();
    // Get the default BLE adapter and start scanning for devices
    const adapter = await bluetooth.defaultAdapter();
    await adapter.startDiscovery();
    console.log('Discovery started...');

    // Attempt to connect to Arduino in a loop
    await connectToDevice(adapter, destroy);

    // Once done, stop scanning (optional)
    await adapter.stopDiscovery();

    // Listen for console input - type 'exit' to disconnect
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
        // Truncate input for the Nordic UART 20-byte limit
        inStr = (inStr.length > 20) ? inStr.slice(0, 20) : inStr;
        // If we have a TX characteristic and are connected, send the typed data to Arduino
        if (txChar && isConnected) {
            await txChar.writeValue(Buffer.from(inStr)).then(() => {
                console.log('Sent: ' + inStr);
            }).catch(err => {
                console.error('Error writing to TX characteristic:', err);
            });
        }
    });
}

// Start the main function and log any errors
main().then((ret) => {
    if (ret) console.log(ret);
}).catch((err) => {
    if (err) console.error(err);
});