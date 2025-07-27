# Meterreader

This project is a small client-side web app for reading five-dial analog electricity meters. It runs entirely in the browser and uses OpenCV.js for the image processing so no server is required.

## Setup

1. Clone or download this repository.
2. From the project directory run a simple web server (camera access requires HTTPS or localhost). For example:
   ```bash
   python3 -m http.server
   ```
3. Open your browser to `http://localhost:8000/index.html`.

## Features

- **Calibration** – Click **Manual Calibrate** and mark the center of each dial from left to right. The calibration is saved in local storage and can be cleared with **Clear Calibration**.
- **Live Reading** – Check the **Live Read** toggle to continuously process frames from the camera and update the displayed reading.

The application loads **OpenCV.js** from its CDN:

```html
<script async src="https://docs.opencv.org/4.x/opencv.js" onload="onOpenCvReady();"></script>
```
