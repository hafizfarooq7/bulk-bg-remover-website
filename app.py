from flask import Flask, render_template, request, send_file, jsonify
import os
import zipfile
from rembg import remove, new_session
from PIL import Image, ImageFilter
from werkzeug.utils import secure_filename
import uuid
import shutil
import threading

app = Flask(__name__)

UPLOAD_FOLDER = "uploads"
OUTPUT_FOLDER = "processed"

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

session = new_session("isnet-general-use")

progress_tracker = {}

# ------------------------ IMAGE PROCESSING FUNCTIONS ------------------------
def enhance_edges(image):
    image = image.filter(ImageFilter.SMOOTH)
    image = image.filter(ImageFilter.GaussianBlur(radius=1))
    return image

def background_worker(job_id, file_paths, bg_color=None, bg_photo_path=None):
    try:
        temp_out = os.path.join(OUTPUT_FOLDER, job_id)
        os.makedirs(temp_out, exist_ok=True)

        total = len(file_paths)
        processed_output_files = []

        # Load background photo if provided
        background_photo = None
        if bg_photo_path:
            try:
                background_photo = Image.open(bg_photo_path).convert("RGBA")
            except Exception as e:
                print("Error loading background photo:", e)

        for index, input_path in enumerate(file_paths):
            try:
                img = Image.open(input_path).convert("RGBA")
                output = remove(img, session=session)
                output = enhance_edges(output)

                if bg_color:
                    background = Image.new("RGBA", output.size, bg_color)
                    output = Image.alpha_composite(background, output)
                elif background_photo:
                    bg_resized = background_photo.resize(output.size)
                    output = Image.alpha_composite(bg_resized, output)

                out_filename = "processed_" + os.path.basename(input_path)
                out_path = os.path.join(temp_out, out_filename)
                output.save(out_path, format="PNG")
                processed_output_files.append(out_path)

            except Exception as e:
                print("Processing error:", e)

            # REAL progress update
            progress_tracker[job_id] = int(((index + 1) / total) * 100)

        # Create ZIP
        zip_path = os.path.join(OUTPUT_FOLDER, f"{job_id}.zip")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
            for f in processed_output_files:
                zipf.write(f, os.path.basename(f))

        # Cleanup
        for f in file_paths:
            try:
                os.remove(f)
            except:
                pass
        if bg_photo_path:
            try:
                os.remove(bg_photo_path)
            except:
                pass

        shutil.rmtree(os.path.join(UPLOAD_FOLDER, job_id), ignore_errors=True)
        shutil.rmtree(temp_out, ignore_errors=True)

        progress_tracker[job_id] = 100

    except Exception as e:
        print("Background job error:", e)
        progress_tracker[job_id] = -1

# ------------------------ START PROCESS ------------------------
@app.route("/process", methods=["POST"])
def start_processing():
    uploaded = request.files.getlist("images[]")
    bg_color = request.form.get("bg_color")
    bg_photo = request.files.get("bg_photo")  # new support for background photo

    if not uploaded:
        return jsonify({"error": "No files"}), 400

    # Allowed extensions and max size
    allowed_ext = {"jpg", "png", "jpeg", "webp", "heif", "heic"}
    max_size = 10 * 1024 * 1024  # 10 MB

    # Validate uploaded images
    for file in uploaded:
        ext = file.filename.rsplit('.', 1)[-1].lower()
        if ext not in allowed_ext:
            return jsonify({"error": f"File '{file.filename}' has invalid format. Please upload jpg, png, jpeg, webp, heif, or heic."}), 400
        file.seek(0, os.SEEK_END)
        size = file.tell()
        file.seek(0)
        if size > max_size:
            return jsonify({"error": f"File '{file.filename}' is too large ({size // (1024*1024)} MB). Max allowed size is 10 MB."}), 400

    job_id = str(uuid.uuid4())
    progress_tracker[job_id] = 0

    job_upload_dir = os.path.join(UPLOAD_FOLDER, job_id)
    os.makedirs(job_upload_dir, exist_ok=True)

    # Save uploaded images
    saved_paths = []
    for file in uploaded:
        filename = secure_filename(file.filename)
        save_path = os.path.join(job_upload_dir, filename)
        file.save(save_path)
        saved_paths.append(save_path)

    # Validate and save background photo
    bg_photo_path = None
    if bg_photo:
        ext = bg_photo.filename.rsplit('.', 1)[-1].lower()
        if ext not in allowed_ext:
            return jsonify({"error": f"Background photo '{bg_photo.filename}' has invalid format. Please upload jpg, png, jpeg, webp, heif, or heic."}), 400
        bg_photo.seek(0, os.SEEK_END)
        size = bg_photo.tell()
        bg_photo.seek(0)
        if size > max_size:
            return jsonify({"error": f"Background photo '{bg_photo.filename}' is too large ({size // (1024*1024)} MB). Max allowed size is 10 MB."}), 400

        bg_photo_filename = secure_filename(bg_photo.filename)
        bg_photo_path = os.path.join(job_upload_dir, bg_photo_filename)
        bg_photo.save(bg_photo_path)

    # Start background thread
    t = threading.Thread(
        target=background_worker,
        args=(job_id, saved_paths, bg_color, bg_photo_path),
        daemon=True
    )
    t.start()

    return jsonify({"job_id": job_id})

@app.route("/progress/<job_id>")
def check_progress(job_id):
    return jsonify({"progress": progress_tracker.get(job_id, 0)})

@app.route("/download/<job_id>")
def download(job_id):
    zip_path = os.path.join(OUTPUT_FOLDER, f"{job_id}.zip")
    if os.path.exists(zip_path):
        return send_file(zip_path, as_attachment=True)
    return "Not ready", 404

@app.route("/")
def index():
    return render_template("index.html")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
