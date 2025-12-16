// bg-remove.js
const worker = new Worker("bg-worker.js");
// <-- ADD THIS HERE
// --- Load ONNX Runtime ---
let session;
async function loadModel() {
    const modelPath = './ai/modnet_web.onnx'; // MODNet or U²-Net
    session = await ort.InferenceSession.create(modelPath);
    console.log('✅ Model loaded');
}
loadModel();

// --- Helpers ---
function loadImage(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
    });
}

function resizeImage(img, maxSize = 512) {
    const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * ratio);
    canvas.height = Math.round(img.height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
}

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
        input[i] = data[i * 4] / 255.0;
        input[i + 320 * 320] = data[i * 4 + 1] / 255.0;
        input[i + 2 * 320 * 320] = data[i * 4 + 2] / 255.0;
    }

    return new ort.Tensor('float32', input, [1, 3, 320, 320]);
}

function upscaleMask(mask, width, height) {
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = 320;
    srcCanvas.height = 320;
    const sctx = srcCanvas.getContext('2d');

    const imgData = sctx.createImageData(320, 320);
    for (let i = 0; i < mask.length; i++) {
        let v = Math.min(Math.max(mask[i], 0), 1) * 255;
        imgData.data[i * 4 + 3] = v;
    }
    sctx.putImageData(imgData, 0, 0);

    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = width;
    dstCanvas.height = height;
    const dctx = dstCanvas.getContext('2d');

    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(srcCanvas, 0, 0, width, height);

    // Dual-pass blur for smoother edges
    dctx.filter = 'blur(6px)';
    dctx.drawImage(dstCanvas, 0, 0);

    return dstCanvas;
}

// --- Alpha refinement ---
function refineAlpha(alpha) {
    // harden mid values
    alpha = Math.min(Math.max((alpha - 0.08) / 0.85, 0), 1);

    // two-pass gamma
    alpha = Math.pow(alpha, 1.3);
    alpha = Math.pow(alpha, 1.1);

    return alpha;
}
function suppressWeakForeground(r, g, b, a) {
    // very low alpha → kill
    if (a < 0.06) return 0;

    // weak confidence → soften
    if (a < 0.18) return a * 0.6;

    return a;
}


// --- Apply mask with background ---
async function applyMaskWithBackground(originalImg, mask, mode, bgColor="#FFFFFF", bgPhoto=null) {
    const w = originalImg.width;
    const h = originalImg.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(originalImg, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    const maskCanvas = upscaleMask(mask, w, h);
    const mctx = maskCanvas.getContext('2d');
    mctx.filter = 'blur(4px)';
    mctx.drawImage(maskCanvas, 0, 0);
    const maskData = mctx.getImageData(0, 0, w, h).data;

    for (let i = 0; i < data.length; i += 4) {
       let a = maskData[i + 3] / 255;
a = refineAlpha(a);
a = suppressWeakForeground(data[i], data[i+1], data[i+2], a);


        if (a < 0.02) {
            data[i + 3] = 0;
            continue;
        }

        if (a < 0.98) {
            data[i]     *= a;
            data[i + 1] *= a;
            data[i + 2] *= a;
        }

        data[i + 3] = a * 255;
    }

    ctx.putImageData(imgData, 0, 0);

    ctx.globalCompositeOperation = 'destination-over';
    if (mode === 'color') {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, w, h);
    } else if (mode === 'photo' && bgPhoto) {
        ctx.drawImage(bgPhoto, 0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
    return canvas;
}

// --- Display preview ---
function displayPreview(canvas) {
    const previewArea = document.getElementById('previewArea');
    const box = document.createElement('div');
    box.className = 'preview-box';

    const scale = Math.min(140 / canvas.width, 140 / canvas.height, 1);
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = canvas.width * scale;
    previewCanvas.height = canvas.height * scale;
    const ctx = previewCanvas.getContext('2d');
    ctx.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);

    box.appendChild(previewCanvas);
    previewArea.appendChild(box);
}

// --- ZIP download ---
function createZipDownloadButton(files) {
    const zip = new JSZip();
    files.forEach(f => {
        zip.file(f.name.replace(/\.[^/.]+$/, "") + "_bg_removed.png", f.canvas.toDataURL().split(",")[1], {base64:true});
    });

    zip.generateAsync({type:"blob"}).then(content => {
        const link = document.getElementById('zipDownloadBtn');
        link.href = URL.createObjectURL(content);
        link.download = "bg_removed_images.zip";
        link.style.display = 'block';
    });
}

// --- Sequential processing with fake-progress ---
async function removeBackgroundSequentially(files) {
    const progressBar = document.getElementById('progressBar');
    const progressContainer = document.querySelector('.progress');
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressBar.textContent = '0%';
    const previewArea = document.getElementById('previewArea');
    previewArea.innerHTML = '';

    const enableColor = document.getElementById('enableColor');
    const activeBgMode = enableColor.checked
        ? (document.getElementById('bgColor').style.display === 'block' ? 'color' : 'photo')
        : null;
    const bgColorValue = document.getElementById('bgColor').value;
    const bgPhotoFile = document.getElementById('bgPhoto').files[0];
    let bgPhotoImg = null;
    if (bgPhotoFile) bgPhotoImg = await loadImage(bgPhotoFile);

    const processedFiles = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const img = await loadImage(file);
        const resizedCanvas = resizeImage(img, 512);
        const inputTensor = preprocessImage(resizedCanvas);

        const feeds = { [session.inputNames[0]]: inputTensor };

        // --- Fake progress interval ---
        let percentStart = Math.round((i / files.length) * 100);
        let percentEnd = Math.round(((i + 1) / files.length) * 100);
        let fakePercent = percentStart;
        let interval = setInterval(() => {
            fakePercent++;
            if (fakePercent >= percentEnd) clearInterval(interval);
            progressBar.style.width = fakePercent + '%';
            progressBar.textContent = fakePercent + '%';
        }, 20);

        const results = await session.run(feeds);
        const mask = results[session.outputNames[0]].data;

        const finalCanvas = await applyMaskWithBackground(img, mask, activeBgMode, bgColorValue, bgPhotoImg);
        displayPreview(finalCanvas);
        processedFiles.push({name: file.name, canvas: finalCanvas});

        progressBar.style.width = percentEnd + '%';
        progressBar.textContent = percentEnd + '%';
        await new Promise(requestAnimationFrame);
    }

    createZipDownloadButton(processedFiles);
}
const enableColorCheckbox = document.getElementById('enableColor');
const bgColorInput = document.getElementById('bgColor');

enableColorCheckbox.addEventListener('change', () => {
    if (enableColorCheckbox.checked) {
        bgColorInput.style.display = 'block';
    } else {
        bgColorInput.style.display = 'none';
    }
});
// ===== Drag & Drop Handling =====
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

// Initialize selectedFiles array
let selectedFiles = [];

// Click on drop zone triggers file input
dropZone.addEventListener('click', () => fileInput.click());

// When files are selected via browse
fileInput.addEventListener('change', (e) => {
    selectedFiles = Array.from(e.target.files); // store selected files
    updateDropZoneText();
});

// Drag over effect
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

// Remove drag effect
dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

// Handle dropped files
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');

    // convert DataTransfer files to array
    selectedFiles = Array.from(e.dataTransfer.files);
    updateDropZoneText();
});

// Update the drop zone text to show selected filenames
function updateDropZoneText() {
    if (selectedFiles.length > 0) {
        dropZone.querySelector('p').textContent = selectedFiles.map(f => f.name).join(', ');
    } else {
        dropZone.querySelector('p').textContent = '📁 Drag & Drop images here\nor click to browse';
    }
}

// --- Process button ---
document.getElementById('processBtn').onclick = async () => {
    if (!selectedFiles.length) {
        alert("Please select files!");
        return;
    }

    document.getElementById('previewArea').innerHTML = '';
    await removeBackgroundSequentially(selectedFiles);
};
