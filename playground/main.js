let msgpack = MessagePack;

// Safely get the decode function from the global 'msgpack' object.
// This resolves the 'msgpack is not defined' error.
if (typeof msgpack === 'undefined' || typeof msgpack.decode === 'undefined') {
    document.getElementById('message').textContent = "ERROR: MessagePack library failed to load.";
}
const { decode } = msgpack;


ws = new WebSocket("ws://127.0.0.1:9001/");
ws.binaryType = "arraybuffer";

ws.onmessage = function (event) {
    decodeAndDisplayImage(new Uint8Array(event.data))
};

ws.onerror = function (event) {
    domMessage.textContent = 'Error with streaming. Is the data streamed?'
};

// --- 1. MOCK DATA SIMULATION ---
// This Uint8Array represents the binary data you would receive from your 
// server's HTTP response (the output of the Python 'pack_image.py' script).
// It's MessagePack encoded: {'picture': binary_jpeg_data}
const packedImageBuffer = new Uint8Array([
    0x81, // Map header (1 element)
    0xA7, 0x70, 0x69, 0x63, 0x74, 0x75, 0x72, 0x65, // Key: "picture"
    0xC4, 0x14, // Bin header (20 bytes follow)
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00 // Mock JPEG data
]);

// --- 2. DOM Elements ---
const decodeButton = document.getElementById('decodeButton');
const clearButton = document.getElementById('clearButton');
const outputImage = document.getElementById('output-image');
const messageElement = document.getElementById('message');
const statusLog = document.getElementById('statusLog');

let currentObjectURL = null;

function logStatus(msg, isError = false) {
    statusLog.classList.remove('hidden');
    statusLog.classList.toggle('text-red-400', isError);
    statusLog.classList.toggle('text-green-400', !isError);
    statusLog.textContent = msg + '\n\n' + statusLog.textContent;
}

function clearOutput() {
    outputImage.src = '';
    outputImage.classList.add('hidden');
    messageElement.textContent = 'Output cleared. Click "Decode MessagePack" to try again.';
    messageElement.classList.remove('hidden');
    statusLog.textContent = '';
    statusLog.classList.add('hidden');
    if (currentObjectURL) {
        URL.revokeObjectURL(currentObjectURL);
        currentObjectURL = null;
        logStatus('Revoked previous Object URL to free up memory.', false);
    }
}

function decodeAndDisplayImage(packedImageBuffer) {
    clearOutput();
    logStatus('--- Starting Decode Process ---');

    // --- DECODE STEP ---
    // 1. Decode the MessagePack buffer (simulating the raw network response)
    logStatus('1. Decoding MessagePack payload...');
    let decodedObject;
    try {
        // The decode function takes the raw ArrayBuffer or Uint8Array
        decodedObject = decode(packedImageBuffer);
        logStatus('   -> Successfully decoded MessagePack structure.');
    } catch (e) {
        logStatus(`Error during MessagePack decoding: ${e.message}`, true);
        return;
    }

    // 2. Extract the binary array (Uint8Array)
    const jpegUint8Array = decodedObject.picture;
    
    if (!jpegUint8Array || !(jpegUint8Array instanceof Uint8Array)) {
        logStatus('Error: Decoded object does not contain a valid Uint8Array at the "picture" key.', true);
        return;
    }
    
    logStatus(`2. Extracted 'picture' data (Type: ${jpegUint8Array.constructor.name}, Length: ${jpegUint8Array.length} bytes).`);


    // --- BLOB CREATION & DISPLAY STEP ---
    // 3. Create a Blob object from the Uint8Array
    logStatus('3. Creating Blob (Content Type: image/jpeg)...');
    const jpegBlob = new Blob([jpegUint8Array], { type: 'image/jpeg' });

    // 4. Create a temporary URL for the image
    currentObjectURL = URL.createObjectURL(jpegBlob);
    logStatus('4. Created Object URL for <img> tag source.');

    // 5. Display the image
    outputImage.src = currentObjectURL;
    outputImage.classList.remove('hidden');
    messageElement.classList.add('hidden');
    
    logStatus('--- Image Displayed Successfully ---');
    logStatus('NOTE: The image uses a simple 20-byte mock JPEG header and will appear as a broken image icon if your browser is strict, but the process of decoding to Uint8Array and creating the Blob is successful.');
}

// --- Event Listeners ---
decodeButton.addEventListener('click', decodeAndDisplayImage);
clearButton.addEventListener('click', clearOutput);

// Initial setup
clearOutput();
