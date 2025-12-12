from flask import Flask, render_template, request, send_file, jsonify
import os
import zipfile
from rembg import remove, new_session
from PIL import Image, ImageFilter
from werkzeug.utils import secure_filename
import uuid
import shutil
import threading
import io

app = Flask(__name__)

UPLOAD_FOLDER = "uploads"
OUTPUT_FOLDER = "processed"

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# Initialize rembg session
session = new_session("isnet-general-use")  # high-quality U2Net model

progress_tracker = {}

# ------------------------ IMAGE PROCESSING FUNCTIONS ------------------------
def enhance_edges(image):
    """
    Enhance edges slightly with smoothing and Gaussian blur.
    Improves hair/fine details handling.
    """
    image = image.filter(ImageFilter.SMOOTH_MORE)
    image = image.filter(ImageFilter.GaussianBlur(radius=0.5))
    return image

MAX_DIMENSION = 5000  # maximum allowed width or height in pixels

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

        # Sequentially process each image (memory-safe)
        for index, input_path in enumerate(file_paths):
            try:
                # Open image from disk (one at a time)
                with Image.open(input_path) as img:
                    img = img.convert("RGBA")

                    # Dimension check again just in case (skip if too large)
                    if img.width > MAX_DIMENSION or img.height > MAX_DIMENSION:
                        print(f"Skipping {input_path}: dimensions exceed {MAX_DIMENSION}px")
                        # Update progress for skipped image and continue
                        progress_tracker[job_id] = int(((index + 1) / total) * 100)
                        continue

                    # --- remove background using rembg session ---
                    output = remove(img, session=session)

                    # Enhance edges
                    output = enhance_edges(output)

                    # Apply background color or photo
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
                # Log processing error for this particular file and continue
                print(f"Processing error for {input_path}: {e}")

            # Update progress after each image (so UI can reflect)
            progress_tracker[job_id] = int(((index + 1) / total) * 100)

        # Only create ZIP if more than one image was successfully processed
        if len(processed_output_files) > 1:
            zip_path = os.path.join(OUTPUT_FOLDER, f"{job_id}.zip")
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
                for f in processed_output_files:
                    zipf.write(f, os.path.basename(f))
        elif len(processed_output_files) == 1:
            # For single image, just move processed image to OUTPUT_FOLDER
            single_path = processed_output_files[0]
            ext = os.path.splitext(single_path)[1]
            new_path = os.path.join(OUTPUT_FOLDER, f"{job_id}{ext}")
            shutil.move(single_path, new_path)
        else:
            # No images processed successfully
            print("No images were successfully processed.")
            progress_tracker[job_id] = -1
            # Cleanup uploaded files/folders then return
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
            return

        # Cleanup uploaded files and temporary files
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

# ------------------------ ROUTES ------------------------
@app.route("/process", methods=["POST"])
def start_processing():
    uploaded = request.files.getlist("images[]")
    bg_color = request.form.get("bg_color")
    bg_photo = request.files.get("bg_photo")

    if not uploaded:
        return jsonify({"error": "No files selected. Please choose up to 50 images (Max 10 MB each)."}), 400

    # Allowed extensions and max size
    allowed_ext = {"jpg", "png", "jpeg", "webp", "heif", "heic"}
    max_size = 10 * 1024 * 1024  # 10 MB

    # Validate uploaded images
    if len(uploaded) > 50:
        return jsonify({"error": "Too many images selected. Maximum 50 images per upload."}), 400

    # PRE-CHECK dimensions and sizes BEFORE saving files
    for file in uploaded:
        # basic extension check
        ext = file.filename.rsplit('.', 1)[-1].lower()
        if ext not in allowed_ext:
            return jsonify({"error": f"File '{file.filename}' has invalid format."}), 400

        # size check
        file.seek(0, os.SEEK_END)
        size = file.tell()
        file.seek(0)
        if size > max_size:
            return jsonify({"error": f"File '{file.filename}' is too large."}), 400

        # dimension check: read a small preview from the stream without saving permanently
        try:
            # read into BytesIO to inspect dimensions
            b = io.BytesIO(file.read())
            b.seek(0)
            with Image.open(b) as im:
                w, h = im.size
                if w > MAX_DIMENSION or h > MAX_DIMENSION:
                    return jsonify({"error": f"File '{file.filename}' dimensions ({w}x{h}) exceed maximum {MAX_DIMENSION}px. Please resize and try again."}), 400
        except Exception as e:
            # If PIL can't open it, return error
            return jsonify({"error": f"Could not read '{file.filename}': {e}"}), 400
        finally:
            # reset stream position so it can be saved later
            try:
                file.stream.seek(0)
            except:
                pass

    job_id = str(uuid.uuid4())
    progress_tracker[job_id] = 0

    job_upload_dir = os.path.join(UPLOAD_FOLDER, job_id)
    os.makedirs(job_upload_dir, exist_ok=True)

    saved_paths = []
    for file in uploaded:
        filename = secure_filename(file.filename)
        save_path = os.path.join(job_upload_dir, filename)
        file.save(save_path)
        saved_paths.append(save_path)

    # Validate and save background photo
    bg_photo_path = None
    if bg_photo and bg_photo.filename:
        ext = bg_photo.filename.rsplit('.', 1)[-1].lower()
        if ext not in allowed_ext:
            return jsonify({"error": f"Background photo '{bg_photo.filename}' has invalid format."}), 400
        bg_photo.seek(0, os.SEEK_END)
        size = bg_photo.tell()
        bg_photo.seek(0)
        if size > max_size:
            return jsonify({"error": f"Background photo '{bg_photo.filename}' is too large."}), 400

        # Check bg photo dimensions as well
        try:
            b = io.BytesIO(bg_photo.read())
            b.seek(0)
            with Image.open(b) as im:
                w, h = im.size
                if w > MAX_DIMENSION or h > MAX_DIMENSION:
                    return jsonify({"error": f"Background photo '{bg_photo.filename}' dimensions ({w}x{h}) exceed maximum {MAX_DIMENSION}px. Please resize and try again."}), 400
        except Exception as e:
            return jsonify({"error": f"Could not read background photo '{bg_photo.filename}': {e}"}), 400
        finally:
            try:
                bg_photo.stream.seek(0)
            except:
                pass

        bg_photo_filename = secure_filename(bg_photo.filename)
        bg_photo_path = os.path.join(job_upload_dir, bg_photo_filename)
        bg_photo.save(bg_photo_path)

    # Start background thread (sequential processing inside worker)
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
    # Check if zip exists first
    zip_path = os.path.join(OUTPUT_FOLDER, f"{job_id}.zip")
    if os.path.exists(zip_path):
        return send_file(zip_path, as_attachment=True)

    # If no zip, check for single image
    for file in os.listdir(OUTPUT_FOLDER):
        if file.startswith(job_id):
            return send_file(os.path.join(OUTPUT_FOLDER, file), as_attachment=True)

    return "Not ready", 404

@app.route("/")
def index():
    return render_template("index.html")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
