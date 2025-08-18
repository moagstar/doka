/**
 * Digital Darkroom Simulator
 * Contact Sheet functionality for browsing and selecting images
 */

// File System Access API variables
let directoryHandle = null;
let fileHandles = [];
let currentFileHandle = null;

// Check if File System Access API is supported
const isFileSystemAccessSupported = 'showDirectoryPicker' in window;

// Select a folder using File System Access API
async function selectFolder() {
  try {
    if (!isFileSystemAccessSupported) {
      alert('Your browser does not support the File System Access API. Please use Chrome or Edge.');
      return;
    }

    // Show directory picker
    directoryHandle = await window.showDirectoryPicker();

    // Save the directory handle to localStorage and IndexedDB
    try {
      // Store the folder name in localStorage (for UI display)
      localStorage.setItem('selectedFolderName', directoryHandle.name);

      // Persist the handle (so we can reopen without user input next time)
      try {
        await idbSet('directoryHandle', directoryHandle);
      } catch (e) {
        console.warn('Could not persist directory handle:', e);
      }
    } catch (storageError) {
      console.error('Error saving folder to localStorage:', storageError);
    }

    // Scan for JPEG files in the folder
    await scanFolderForImages();
  } catch (error) {
    console.error('Error selecting folder:', error);
    if (error.name !== 'AbortError') {
      alert('Error selecting folder: ' + error.message);
    }
  }
}

// Scan the selected folder for JPEG files
async function scanFolderForImages() {
  if (!directoryHandle) return;

  // Check if we have permission to access the directory
  if (!await ensureDirPermission()) {
    console.warn('Permission to access directory was denied. Please select the folder again.');
    return;
  }

  try {
    fileHandles = [];

    // Iterate through all files in the directory
    for await (const entry of directoryHandle.values()) {
      if (entry.kind === 'file') {
        const name = entry.name.toLowerCase();
        // Check if the file is a JPEG
        if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
          fileHandles.push(entry);
        }
      }
    }

    console.log(`Found ${fileHandles.length} JPEG files in the folder`);

    // Rebuild the contact sheet with the found images
    SHEETS.forEach(buildSheet);
  } catch (error) {
    console.error('Error scanning folder:', error);
    alert('Error scanning folder: ' + error.message);
  }
}

// Get project data from a JSON file next to the JPEG
async function getProjectDataForImage(fileHandle) {
  try {
    const jsonFileName = fileHandle.name.substring(0, fileHandle.name.lastIndexOf('.')) + '.json';

    // Try to get the JSON file with the same name
    try {
      const jsonFileHandle = await directoryHandle.getFileHandle(jsonFileName);
      const file = await jsonFileHandle.getFile();
      const text = await file.text();
      return JSON.parse(text);
    } catch (error) {
      // JSON file doesn't exist or can't be read, which is fine for new images
      return null;
    }
  } catch (error) {
    console.error('Error getting project data:', error);
    return null;
  }
}

// Ensure we have permission to access the directory
async function ensureDirPermission() {
  if (!directoryHandle) return false;

  // Check if we already have permission
  const options = { mode: 'read' };
  if ((await directoryHandle.queryPermission(options)) === 'granted') {
    return true;
  }

  // Request permission
  if ((await directoryHandle.requestPermission(options)) === 'granted') {
    return true;
  }

  return false;
}

// Try to restore the previously selected directory
async function restoreDirectoryHandle() {
  try {
    // Get the directory handle from IndexedDB
    const savedHandle = await idbGet('directoryHandle');
    if (savedHandle) {
      // Check if we still have permission to access it
      if ((await savedHandle.queryPermission({ mode: 'read' })) === 'granted') {
        directoryHandle = savedHandle;

        // Display the folder name in the UI
        const folderName = localStorage.getItem('selectedFolderName');
        if (folderName) {
          updateFolderDisplay(folderName);
        }

        // Scan for images
        await scanFolderForImages();
        return true;
      } else {
        console.log('Permission to access previously selected directory was denied');
      }
    }
  } catch (error) {
    console.error('Error restoring directory handle:', error);
  }
  return false;
}

// Update the folder display in the UI
function updateFolderDisplay(folderName) {
  const folderPathEl = document.querySelector('.folder-path');
  if (folderPathEl) {
    folderPathEl.textContent = folderName;
    folderPathEl.classList.remove('hidden');
  }
}

// Open an image in the darkroom
async function openImageInDarkroom(fileHandle) {
  if (!fileHandle) return;

  try {
    // Store the file handle in IndexedDB so darkroom can access it
    await idbSet('currentFileHandle', fileHandle);

    // Also store the directory handle if it exists
    if (directoryHandle) {
      await idbSet('darkroomDirectoryHandle', directoryHandle);
    }

    // Navigate to darkroom.html with the file handle ID
    window.location.href = `darkroom.html?fileHandleId=currentFileHandle`;
  } catch (error) {
    console.error('Error opening image in darkroom:', error);
    alert('Error opening image: ' + error.message);
  }
}

// Contact sheet functionality
const SHEETS = [];

// Initialize a sheet
function initSheet(sheetEl) {
  if (!sheetEl) return null;

  const sheet = {
    el: sheetEl,
    id: sheetEl.id,
    rows: parseInt(sheetEl.dataset.rows || 4, 10),
    cols: parseInt(sheetEl.dataset.cols || 5, 10),
    frames: []
  };

  // Update the CSS variables
  sheetEl.style.setProperty('--rows', sheet.rows);
  sheetEl.style.setProperty('--cols', sheet.cols);

  SHEETS.push(sheet);
  return sheet;
}

// Build a sheet with frames
function buildSheet(sheet) {
  if (!sheet || !sheet.el) return;

  // Clear existing frames
  sheet.el.innerHTML = '';
  sheet.frames = [];

  // Calculate how many frames we need - only create as many frames as we have images
  const totalFrames = fileHandles.length > 0 ? fileHandles.length : 0;

  // Create frames
  for (let i = 0; i < totalFrames; i++) {
    const frame = createFrame(sheet, i);
    sheet.frames.push(frame);
    sheet.el.appendChild(frame.el);
  }

  // Update the sheet with images if we have file handles
  updateSheetWithImages(sheet);

  // Add single-frame class if there's only one frame
  if (totalFrames === 1) {
    sheet.el.classList.add('single-frame');
  } else {
    sheet.el.classList.remove('single-frame');
  }
}

// Create a frame element
function createFrame(sheet, index) {
  const frameEl = document.createElement('div');
  frameEl.className = 'frame is-empty';
  frameEl.dataset.index = index;

  const windowEl = document.createElement('div');
  windowEl.className = 'window';
  frameEl.appendChild(windowEl);

  const hitEl = document.createElement('div');
  hitEl.className = 'hit';
  windowEl.appendChild(hitEl);

  // Add click handler to open folder selector if no directory is selected
  hitEl.addEventListener('click', async () => {
    if (!directoryHandle) {
      await selectFolder();
    } else {
      // If we have a file handle for this frame, open it in the darkroom
      const frame = sheet.frames[index];
      if (frame && frame.fileHandle) {
        await openImageInDarkroom(frame.fileHandle);
      }
    }
  });

  return {
    el: frameEl,
    index: index,
    fileHandle: null
  };
}

// Update a sheet with images from file handles
function updateSheetWithImages(sheet) {
  if (!sheet || !fileHandles.length) return;

  // Calculate the starting index for this sheet
  const startIndex = 0; // For now, we only have one sheet

  // Update frames with images - since we're creating exactly the right number of frames,
  // we can simply update each frame with its corresponding image
  for (let i = 0; i < sheet.frames.length; i++) {
    const fileIndex = startIndex + i;
    const frame = sheet.frames[i];
    updateFrameWithImage(frame, fileHandles[fileIndex]);
  }
}

// Update a frame with an image
async function updateFrameWithImage(frame, fileHandle) {
  if (!frame || !fileHandle) return;

  try {
    // Store the file handle in the frame
    frame.fileHandle = fileHandle;

    // Get the file from the file handle
    const file = await fileHandle.getFile();

    // Create a URL for the file
    const imageUrl = URL.createObjectURL(file);

    // Get the frame elements
    const frameEl = frame.el;
    const hitEl = frameEl.querySelector('.hit');

    // Clear any existing image
    hitEl.innerHTML = '';

    // Create and add the image
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = fileHandle.name;

    // Check if the image is portrait or landscape
    img.onload = function() {
      if (img.naturalHeight > img.naturalWidth) {
        img.classList.add('portrait');
      }
      URL.revokeObjectURL(imageUrl);
    };

    hitEl.appendChild(img);

    // Update the frame class
    frameEl.classList.remove('is-empty');
    frameEl.classList.add('is-existing');
  } catch (error) {
    console.error('Error updating frame with image:', error);
    clearFrame(frame);
  }
}

// Clear a frame
function clearFrame(frame) {
  if (!frame) return;

  // Clear the file handle
  frame.fileHandle = null;

  // Get the frame elements
  const frameEl = frame.el;
  const hitEl = frameEl.querySelector('.hit');

  // Clear any existing image
  hitEl.innerHTML = '';

  // Update the frame class
  frameEl.classList.remove('is-existing');
  frameEl.classList.add('is-empty');

  // Remove any edited indicator
  const indicator = frameEl.querySelector('.edited-indicator');
  if (indicator) {
    indicator.remove();
  }
}

// Initialize the contact sheet when the page loads
document.addEventListener('DOMContentLoaded', async function() {
  // Initialize all sheets
  document.querySelectorAll('.sheet-grid').forEach(initSheet);

  // Create folder select button if it doesn't exist
  if (!document.querySelector('.folder-select-container')) {
    const folderSelectContainer = document.createElement('div');
    folderSelectContainer.className = 'folder-select-container';

    const folderSelectButton = document.createElement('button');
    folderSelectButton.className = 'folder-select-button';
    folderSelectButton.textContent = 'Select Folder';
    folderSelectButton.addEventListener('click', selectFolder);

    const folderPath = document.createElement('div');
    folderPath.className = 'folder-path hidden';

    folderSelectContainer.appendChild(folderSelectButton);
    folderSelectContainer.appendChild(folderPath);

    document.body.appendChild(folderSelectContainer);
  }

  // Try to restore the previously selected directory
  const restored = await restoreDirectoryHandle();

  // If we couldn't restore, show a message to select a folder
  if (!restored) {
    const sheetA = document.getElementById('sheetA');
    if (sheetA && sheetA.children.length === 0) {
      const message = document.createElement('div');
      message.className = 'select-folder-message';
      message.textContent = 'Please select a folder containing JPEG images';
      sheetA.appendChild(message);
    }
  }
});
