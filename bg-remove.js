const MAX_FILES = 50;
const MAX_FILE_SIZE_MB = 10;
const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'heic', 'heif'];

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

    // scale canvas to fit nicely inside box
    const scale = Math.min(140 / canvas.width, 140 / canvas.height, 1);
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = canvas.width * scale;
    previewCanvas.height = canvas.height * scale;

    const ctx = previewCanvas.getContext('2d');
    ctx.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);

    // add golden border to the canvas itself
    previewCanvas.style.border = "2px solid #FFD700";
    previewCanvas.style.borderRadius = "8px"; // optional rounded corners

    box.appendChild(previewCanvas);
    previewArea.appendChild(box);
}



// --- ZIP download ---
function createZipDownloadButton(files) {

    // ✅ CASE 1: Only ONE image → direct download (NO ZIP)
    if (files.length === 1) {
        const f = files[0];

        f.canvas.toBlob((blob) => {
            const url = URL.createObjectURL(blob);
            const link = document.getElementById('zipDownloadBtn');

            link.href = url;

            // keep original filename, just add suffix
            link.download = f.name.replace(/\.[^/.]+$/, "") + "_bg_removed.png";

            link.style.display = 'block';
        });

        return; // ⛔ stop here, no ZIP
    }

    // ✅ CASE 2: Multiple images → ZIP (your original logic)
    const zip = new JSZip();

    files.forEach(f => {
        zip.file(
            f.name.replace(/\.[^/.]+$/, "") + "_bg_removed.png",
            f.canvas.toDataURL().split(",")[1],
            { base64: true }
        );
    });

    zip.generateAsync({ type: "blob" }).then(content => {
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
// ===== Background checkbox + buttons logic =====
const enableColorCheckbox = document.getElementById('enableColor');
const bgModeButtons = document.getElementById('bgModeButtons');
const btnBackground = document.getElementById('btnBackground');
const btnColor = document.getElementById('btnColor');
const bgColorInput = document.getElementById('bgColor');
const bgPhotoInput = document.getElementById('bgPhoto');

// Initially hide buttons and inputs
bgModeButtons.style.display = 'none';
bgColorInput.style.display = 'none';
bgPhotoInput.style.display = 'none';

enableColorCheckbox.addEventListener('change', () => {
    if (enableColorCheckbox.checked) {
        bgModeButtons.style.display = 'flex'; // show buttons
    } else {
        bgModeButtons.style.display = 'none'; // hide buttons
        bgColorInput.style.display = 'none';
        bgPhotoInput.style.display = 'none';
        bgPhotoInput.value = ''; // reset
    }
});

// When Color button is clicked, open color picker
btnColor.addEventListener('click', () => {
    bgColorInput.style.display = 'block';
    bgColorInput.click();
});

// When Background button is clicked, open file selector
btnBackground.addEventListener('click', () => {
    bgPhotoInput.style.display = 'block';
    bgPhotoInput.click();
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
const fileCount = document.getElementById('fileCount');

function updateDropZoneText() {
    if (selectedFiles.length > 0) {
        // Update drop zone preview
        dropZone.querySelector('p').textContent = selectedFiles.map(f => f.name).join(', ');
        // Update file count
        fileCount.textContent = `${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''} selected`;
    } else {
        dropZone.querySelector('p').textContent = '📁 Drag & Drop images here\nor click to browse';
        fileCount.textContent = 'No files selected';
    }
}


document.getElementById('processBtn').onclick = async () => {
    if (!selectedFiles.length) {
        alert("Please select files!");
        return;
    }

    // ✅ CHECK 1: max files
    if (selectedFiles.length > MAX_FILES) {
        alert(
            `❌ Too many images selected\n\n` +
            `Selected: ${selectedFiles.length}\n` +
            `Maximum allowed: ${MAX_FILES}`
        );
        return;
    }

    // ✅ CHECK 2 & 3: size + extension
    for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];

        // size check
        const sizeMB = file.size / (1024 * 1024);
        if (sizeMB > MAX_FILE_SIZE_MB) {
            alert(
                `❌ Image too large\n\n` +
                `File: ${file.name}\n` +
                `Size: ${sizeMB.toFixed(2)} MB\n` +
                `Max allowed: ${MAX_FILE_SIZE_MB} MB`
            );
            return;
        }

        // extension check (SAFE)
        const ext = file.name.split('.').pop().toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(ext)) {
            alert(
                `❌ Unsupported file format\n\n` +
                `File: ${file.name}\n\n` +
                `Allowed formats:\nJPG, JPEG, PNG, HEIC, HEIF`
            );
            return;
        }
    }

    // 🚀 ORIGINAL FLOW — UNTOUCHED
    document.getElementById('previewArea').innerHTML = '';
    await removeBackgroundSequentially(selectedFiles);
};

