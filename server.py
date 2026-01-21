# server.py  (FINAL – MODNet ONLY)

import os
import io
import numpy as np
from PIL import Image
from flask import Flask, request, send_file, render_template
import onnxruntime as ort

# -----------------------------
# Flask App
# -----------------------------
app = Flask(__name__, template_folder="templates", static_folder="static")

@app.route("/")
def index():
    return render_template("index.html")

# -----------------------------
# Load MODNet (ONNX)
# -----------------------------
MODEL_PATH = os.path.join(os.path.dirname(__file__), "modnet_web.onnx")

session = ort.InferenceSession(
    MODEL_PATH,
    providers=["CPUExecutionProvider"]
)

input_name = session.get_inputs()[0].name
output_name = session.get_outputs()[0].name

print("✅ MODNet loaded (ONNX, CPU)")

# -----------------------------
# Remove Background Route
# -----------------------------
@app.route("/remove-bg", methods=["POST"])
def remove_bg():
    if "image" not in request.files:
        return "No image provided", 400

    file = request.files["image"]
    img = Image.open(file).convert("RGB")

    w, h = img.size

    # --- MODNet expects 512x512 ---
    img_resized = img.resize((512, 512))
    img_np = np.array(img_resized).astype(np.float32) / 255.0
    img_np = np.transpose(img_np, (2, 0, 1))  # CHW
    img_np = np.expand_dims(img_np, 0)        # NCHW

    # --- Inference ---
    matte = session.run(
        [output_name],
        {input_name: img_np}
    )[0]

    matte = matte[0, 0]  # HxW
    matte = np.clip(matte, 0, 1)

    # --- Resize alpha back ---
    alpha = Image.fromarray((matte * 255).astype(np.uint8)).resize((w, h))
    alpha = np.array(alpha)

    # --- Compose RGBA ---
    img_np = np.array(img)
    result = np.dstack([img_np, alpha])

    result_img = Image.fromarray(result, "RGBA")

    buf = io.BytesIO()
    result_img.save(buf, format="PNG")
    buf.seek(0)

    return send_file(buf, mimetype="image/png")

# -----------------------------
# Run
# -----------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
