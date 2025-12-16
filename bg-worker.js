importScripts("https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js");

let session = null;

async function loadModel() {
    session = await ort.InferenceSession.create("./ai/modnet_web.onnx");
    console.log("MODNet loaded in worker");
}
loadModel();

self.onmessage = async (e) => {
    const { imageData } = e.data;

    const input = new Float32Array(3 * 320 * 320);

    for (let i = 0; i < 320 * 320; i++) {
        input[i] = imageData[i * 4] / 255;
        input[i + 320 * 320] = imageData[i * 4 + 1] / 255;
        input[i + 2 * 320 * 320] = imageData[i * 4 + 2] / 255;
    }

    const tensor = new ort.Tensor("float32", input, [1, 3, 320, 320]);
    const feeds = { [session.inputNames[0]]: tensor };
    const results = await session.run(feeds);

    const mask = results[session.outputNames[0]].data;
    self.postMessage({ mask });
};
