// bg-remove.js

// Load ONNX Runtime
let session;

async function loadModel() {
    session = await ort.InferenceSession.create('./ai/u2netp.onnx');
    console.log('U2NetP model loaded');
}

loadModel();

// Helpers
function loadImage(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
    });
}

// Preprocess image for U2NetP (320x320)
function preprocessImage(img) {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 320;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 320, 320);
    const imageData = ctx.getImageData(0, 0, 320, 320);
    const data = imageData.data;
    const input = new Float32Array(3 * 320 * 320);

    for (let i = 0; i < 320 * 320; i++) {
        input[i] = data[i * 4] / 255.0; // R
        input[i + 320 * 320] = data[i * 4 + 1] / 255.0; // G
        input[i + 2 * 320 * 320] = data[i * 4 + 2] / 255.0; // B
    }

    return new ort.Tensor('float32', input, [1, 3, 320, 320]);
}

// Apply mask to original image to remove background
function applyMask(originalImg, mask) {
    const canvas = document.createElement('canvas');
    canvas.width = originalImg.width;
    canvas.height = originalImg.height;
    const ctx = canvas.getContext('2d');

    // Draw original image
    ctx.drawImage(originalImg, 0, 0, canvas.width, canvas.height);

    // Get image data
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;

    // Resize mask to original image
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = 320;
    maskCanvas.height = 320;
    const maskCtx = maskCanvas.getContext('2d');
    const maskImgData = maskCtx.createImageData(320, 320);
    for (let i = 0; i < mask.length; i++) {
        maskImgData.data[i * 4 + 3] = mask[i] * 255; // alpha channel
    }

    // Scale mask to original size
    maskCtx.putImageData(maskImgData, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);

    return canvas;
}

// Display result and enable download
function displayResult(canvas, filename) {
    const downloadArea = document.getElementById('downloadArea');
    const dataUrl = canvas.toDataURL('image/png');

    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename.replace(/\.[^/.]+$/, "") + "_bg_removed.png";
    link.textContent = `⬇️ Download ${filename}`;
    link.style.display = 'block';
    link.style.margin = '8px auto';
    link.style.color = '#fff';
    downloadArea.appendChild(link);
}

// Sequential processing
async function removeBackgroundSequentially(files) {
    const progressBar = document.getElementById('progressBar');
    const progressContainer = document.querySelector('.progress');
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressBar.textContent = '0%';

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const img = await loadImage(file);
        const inputTensor = preprocessImage(img);

        const feeds = { 'input': inputTensor }; // adjust input name if different
        const results = await session.run(feeds);
        const mask = results['output'].data; // adjust output name if different

        const finalCanvas = applyMask(img, mask);
        displayResult(finalCanvas, file.name);

        // Update progress
        const percent = Math.round(((i + 1) / files.length) * 100);
        progressBar.style.width = percent + '%';
        progressBar.textContent = percent + '%';
    }
}

// Bind to your existing process button
const processBtn = document.getElementById('processBtn');
processBtn.onclick = async () => {
    const fileInput = document.getElementById('fileInput');
    const files = Array.from(fileInput.files);

    if (!files.length) {
        alert("Please select files!");
        return;
    }

    // Stop button animation
    processBtn.style.animation = "none";

    // Clear previous downloads
    document.getElementById('downloadArea').innerHTML = '';

    await removeBackgroundSequentially(files);
};
