const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const {
  normalizeExcludeNames,
  shouldSkipDirectoryName,
  shouldSkipFileName,
  shouldSkipEntryPath,
  compileExcludeDirs,
  isExcludedDir
} = require('./scan-skip');

// We'll load StreamZip after receiving the node_modules path from the main process
let StreamZip = null;
let nodeModulesPath = null;

// Function to load StreamZip from the correct location
function loadStreamZip() {
  if (StreamZip) return StreamZip;
  
  try {
    // First try normal require (works when worker is in app directory)
    StreamZip = require('node-stream-zip');
    return StreamZip;
  } catch (error) {
    // If that fails, try to find it from the app's node_modules
    const possiblePaths = [];
    
    // Add the passed node_modules path if available (make it absolute)
    if (nodeModulesPath) {
      const absoluteNodeModules = path.isAbsolute(nodeModulesPath) 
        ? nodeModulesPath 
        : path.resolve(nodeModulesPath);
      possiblePaths.push(path.join(absoluteNodeModules, 'node-stream-zip'));
    }
    
    // Add common locations - use process.resourcesPath for built Electron apps
    const resourcesPath = process.resourcesPath || path.dirname(__dirname);
    possiblePaths.push(
      path.resolve(__dirname, '..', 'node_modules', 'node-stream-zip'),
      path.resolve(__dirname, '..', '..', 'node_modules', 'node-stream-zip'),
      path.resolve(resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-stream-zip'),
      path.resolve(resourcesPath, 'app.asar', 'node_modules', 'node-stream-zip'),
      path.resolve(resourcesPath, 'app', 'node_modules', 'node-stream-zip'),
      // Windows-specific paths
      path.resolve(path.dirname(resourcesPath), 'app.asar.unpacked', 'node_modules', 'node-stream-zip'),
      path.resolve(path.dirname(resourcesPath), 'Resources', 'app.asar.unpacked', 'node_modules', 'node-stream-zip')
    );
    
    // Try each path (normalize to absolute paths)
    for (let modulePath of possiblePaths) {
      // Normalize to absolute path
      if (!path.isAbsolute(modulePath)) {
        modulePath = path.resolve(modulePath);
      }
      
      if (fs.existsSync(modulePath)) {
        try {
          // Try requiring the directory (Node will resolve to index.js or main from package.json)
          // Use path.resolve to ensure we have an absolute path
          const resolvedPath = path.resolve(modulePath);
          StreamZip = require(resolvedPath);
          console.log(`[Worker] Loaded node-stream-zip from: ${resolvedPath}`);
          return StreamZip;
        } catch (requireError) {
          console.log(`[Worker] Failed to require ${modulePath}:`, requireError.message);
          // If directory require fails, try requiring the main file directly
          try {
            const packageJsonPath = path.join(modulePath, 'package.json');
            if (fs.existsSync(packageJsonPath)) {
              const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
              const mainFile = packageJson.main || 'index.js';
              const mainPath = path.resolve(modulePath, mainFile);
              if (fs.existsSync(mainPath)) {
                StreamZip = require(mainPath);
                console.log(`[Worker] Loaded node-stream-zip from main file: ${mainPath}`);
                return StreamZip;
              }
            }
          } catch (mainFileError) {
            console.log(`[Worker] Failed to load from main file:`, mainFileError.message);
            // Continue to next path
            continue;
          }
          // Continue to next path
          continue;
        }
      }
    }
    
    // Last resort: modify Module._nodeModulePaths to include the node_modules path
    if (nodeModulesPath && fs.existsSync(nodeModulesPath)) {
      const originalNodeModulePaths = Module._nodeModulePaths;
      const originalResolveFilename = Module._resolveFilename;
      
      // Modify both _nodeModulePaths and _resolveFilename for better compatibility
      Module._nodeModulePaths = function(from) {
        const paths = originalNodeModulePaths.call(this, from);
        if (!paths.includes(nodeModulesPath)) {
          paths.unshift(nodeModulesPath);
        }
        return paths;
      };
      
      // Also modify _resolveFilename as a fallback
      Module._resolveFilename = function(request, parent, isMain, options) {
        if (request === 'node-stream-zip') {
          const streamZipPath = path.join(nodeModulesPath, 'node-stream-zip');
          if (fs.existsSync(streamZipPath)) {
            try {
              const packageJsonPath = path.join(streamZipPath, 'package.json');
              if (fs.existsSync(packageJsonPath)) {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                const mainFile = packageJson.main || 'index.js';
                const mainPath = path.join(streamZipPath, mainFile);
                if (fs.existsSync(mainPath)) {
                  return mainPath;
                }
              }
              return streamZipPath;
            } catch (e) {
              // Fall through to original resolver
            }
          }
        }
        return originalResolveFilename.call(this, request, parent, isMain, options);
      };
      
      try {
        StreamZip = require('node-stream-zip');
        Module._nodeModulePaths = originalNodeModulePaths;
        Module._resolveFilename = originalResolveFilename;
        console.log(`[Worker] Loaded node-stream-zip using modified Module paths from: ${nodeModulesPath}`);
        return StreamZip;
      } catch (requireError) {
        Module._nodeModulePaths = originalNodeModulePaths;
        Module._resolveFilename = originalResolveFilename;
        console.error(`[Worker] Failed to load node-stream-zip from ${nodeModulesPath}:`, requireError.message);
        console.error(`[Worker] Require error stack:`, requireError.stack);
        // Continue to throw error below
      }
    }
    
    // Log all attempted paths for debugging
    console.error(`[Worker] Cannot find node-stream-zip module. Worker location: ${__dirname}`);
    console.error(`[Worker] process.resourcesPath: ${process.resourcesPath || 'undefined'}`);
    console.error(`[Worker] nodeModulesPath: ${nodeModulesPath || 'undefined'}`);
    console.error(`[Worker] Tried paths:`);
    possiblePaths.forEach(p => {
      const exists = fs.existsSync(p);
      console.error(`[Worker]   ${p} - ${exists ? 'EXISTS' : 'NOT FOUND'}`);
    });
    
    throw new Error(`Cannot find node-stream-zip module. Worker location: ${__dirname}, resourcesPath: ${process.resourcesPath || 'undefined'}, nodeModulesPath: ${nodeModulesPath || 'undefined'}`);
  }
}

// Concurrency limit for file processing
// Higher concurrency in Docker/Server mode to compensate for slower file system operations
// Docker file system operations (especially on network shares) can be 10-100ms per operation
// vs <1ms for local file systems, so we need more parallel operations to maintain throughput
function isDockerContainer() {
  return require('fs').existsSync('/.dockerenv') || 
         (require('fs').existsSync('/proc/self/cgroup') && 
          require('fs').readFileSync('/proc/self/cgroup', 'utf8').includes('docker'));
}

const MAX_CONCURRENT_OPS = isDockerContainer() ? 100 : 50; // Higher concurrency in Docker

/** Always scanned; main's getScanExtensions() merges these with settings-driven additional types. */
const BASE_SCAN_EXTENSIONS = ['.stl', '.3mf'];

/**
 * Normalize extension list from main (includes ADDITIONAL_FILE_TYPES_CATALOG selections: .obj, .step, .stp, …).
 * Used for both directory-queue filtering and processFile / ZIP entry matching so behavior stays consistent.
 */
let scanExcludeNames = new Set();

function buildScanExtensionSet(scanExtensions) {
  const set = new Set();
  const add = (raw) => {
    if (raw == null || raw === '') return;
    const s = String(raw).trim().toLowerCase();
    if (!s) return;
    set.add(s.startsWith('.') ? s : `.${s}`);
  };
  BASE_SCAN_EXTENSIONS.forEach(add);
  if (Array.isArray(scanExtensions)) {
    for (const ext of scanExtensions) add(ext);
  }
  return set;
}

async function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    
    stream.on('error', err => {
      console.error(`Error reading file for hashing: ${filePath}`, err);
      reject(err);
    });

    stream.on('data', chunk => {
      try {
        hash.update(chunk);
      } catch (err) {
        console.error(`Error updating hash for file: ${filePath}`, err);
        reject(err);
      }
    });

    stream.on('end', () => {
      try {
        const fileHash = hash.digest('hex');
        resolve(fileHash);
      } catch (err) {
        console.error(`Error generating final hash for file: ${filePath}`, err);
        reject(err);
      }
    });
  });
}

async function scanDirectory(directoryPath, maxFileSize, enableZipArchives = false, scanExtensions = null, excludeDirectories = null) {
  // Library folder roots are stored with forward slashes for consistent DB
  // storage/matching (see main.js's isUncPath comment), including network
  // shares typed as //server/share/... . That spelling is accepted by our own
  // UNC validation and by Node's path utilities, but it is NOT reliable for
  // actual Windows file I/O: fs.promises.readdir() below can silently fail
  // (ENOENT) on a literal //server/share path even though \\server\share
  // works fine - and the catch block in processDirectory() only logs that
  // failure, it never surfaces it, so the scan completes as if it succeeded
  // having found nothing. path.resolve() normalizes to the real native form
  // (\\server\share\... on win32) with no effect on an already-native path.
  directoryPath = path.resolve(directoryPath);
  // Posting is a no-op when there's no real parentPort (i.e. scanDirectory()
  // was require()'d and called directly, such as from a unit test, rather
  // than run inside an actual worker_threads Worker). Production behavior
  // (always run as a Worker, parentPort always set) is unchanged.
  const post = (msg) => { if (parentPort) parentPort.postMessage(msg); };
  const files = [];
  /** Every file-type dirent seen while walking the tree (matches legacy totalFiles meaning). */
  let traversedFileEntries = 0;
  const extSet = buildScanExtensionSet(scanExtensions);
  const SCAN_FLUSH_BATCH = 400;

  const flushDiscoveredFiles = (force = false) => {
    while (files.length >= SCAN_FLUSH_BATCH || (force && files.length > 0)) {
      const chunk = files.splice(0, Math.min(SCAN_FLUSH_BATCH, files.length));
      post({ type: 'batch', files: chunk });
    }
  };

  const shouldQueueFile = (fileName) => {
    if (shouldSkipFileName(fileName)) return false;
    const ext = path.extname(fileName).toLowerCase();
    if (extSet.has(ext)) return true;
    if (enableZipArchives && ext === '.zip') return true;
    return false;
  };

  // Throttle progress IPC: walking huge folders is sync; avoid flooding the main process.
  const TRAVERSE_PROGRESS_INTERVAL = isDockerContainer() ? 2000 : 1000;

  const reportTraversedFile = () => {
    traversedFileEntries++;
    if (traversedFileEntries % TRAVERSE_PROGRESS_INTERVAL === 0) {
      post({
        type: 'progress',
        processed: traversedFileEntries
      });
    }
  };

  // Use a simple queue system
  const excludedDirs = compileExcludeDirs(excludeDirectories, directoryPath);
  const queue = [{ type: 'dir', path: directoryPath }];
  const seenDirs = new Set();
  let activeOps = 0;

  // Promise to signal completion
  let resolveDone;
  let rejectDone;
  const donePromise = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

  const processNext = () => {
    // If no active ops and queue is empty, we are done
    if (activeOps === 0 && queue.length === 0) {
      if (traversedFileEntries > 0) {
        post({
          type: 'progress',
          processed: traversedFileEntries
        });
      }
      flushDiscoveredFiles(true);
      resolveDone({ files: [], totalFiles: traversedFileEntries });
      return;
    }

    // While we have capacity and items in queue, start processing
    while (activeOps < MAX_CONCURRENT_OPS && queue.length > 0) {
      const item = queue.shift();
      activeOps++;

      if (item.type === 'dir') {
        processDirectory(item.path).finally(() => {
          activeOps--;
          processNext();
        });
      } else if (item.type === 'file') {
        processFile(item.path, item.name).finally(() => {
          activeOps--;
          processNext();
        });
      }
    }
  };

  const processDirectory = async (dirPath) => {
    if (isExcludedDir(dirPath, excludedDirs)) {
      console.log(`Skipping excluded directory ${dirPath}`);
      return;
    }
    if (seenDirs.has(dirPath)) return;
    seenDirs.add(dirPath);

    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        let isDir = entry.isDirectory();

        // entry.isDirectory() reads the Dirent's d_type bit from the
        // readdir() response itself - fast (no extra syscall) but not
        // always trustworthy. Over a UNC path onto a OneDrive-backed
        // folder (cloud placeholder reparse points going through SMB),
        // this has been observed coming back false for a real directory
        // with no indication anything went wrong: no thrown error, just a
        // wrong answer. That silently misroutes the entry into the file
        // branch below, where (having no scan extension) it's dropped
        // without comment - the entire subtree under it is never visited.
        // This is the actual cause of "UNC folder scans but finds
        // nothing": not a thrown error (nothing throws), a wrong type bit.
        // A real stat() follows the reparse point and reports the true
        // type, so when the fast path says "not a directory" AND the name
        // doesn't look like a scannable file either (the case that would
        // otherwise vanish silently), confirm with one stat() before
        // giving up on it. Real files overwhelmingly have one of our
        // scanned extensions and skip this extra call entirely.
        if (!isDir && !shouldQueueFile(entry.name)) {
          try {
            const st = await fs.promises.stat(fullPath);
            isDir = st.isDirectory();
          } catch (_) {
            // Genuinely gone or inaccessible - fall through and let it be
            // counted/dropped as before.
          }
        }

        if (isDir) {
          if (shouldSkipDirectoryName(entry.name, scanExcludeNames)) {
            continue;
          }
          // Prioritize files over directories to keep memory usage lower?
          // Actually directories first might discover more work faster.
          queue.push({ type: 'dir', path: fullPath });
        } else {
          // Only queue model-like files (and zips when enabled). Queuing every file caused
          // millions of async processFile() calls on large trees even when stat() was skipped.
          reportTraversedFile();
          if (shouldQueueFile(entry.name)) {
            queue.push({ type: 'file', path: fullPath, name: entry.name });
          }
        }
      }
    } catch (err) {
      console.error(`Skipping directory ${dirPath} due to error: ${err.message}`);
      // A failure on the scan ROOT itself (e.g. a network share that's offline,
      // unreachable, or no longer has the right credentials) must not be
      // swallowed the way a failure on some nested subfolder reasonably is -
      // previously this was only logged here, so the scan would "complete"
      // having found nothing and the caller (and user) had no way to tell a
      // real failure apart from a folder that's simply empty. processDirectory
      // runs fire-and-forget via .finally() (see processNext above), so a
      // plain throw here would become an unhandled rejection rather than
      // reaching the caller - reject the scan's own donePromise directly
      // instead, which the worker's message handler already turns into a
      // proper { type: 'error' } postMessage.
      if (dirPath === directoryPath) {
        rejectDone(err);
        return;
      }
    }
  };

  const processFile = async (filePath, fileName) => {
    try {
      // Check extension FIRST to avoid unnecessary stat() calls
      const ext = path.extname(fileName).toLowerCase();

      if (extSet.has(ext)) {
        // Only call stat() for valid 3D model files
        const stats = await fs.promises.stat(filePath);
        if (stats.size <= maxFileSize) {
          // Add file without hash calculation (calculate later if needed)
          files.push({
            filePath,
            fileName,
            size: stats.size,
            mtime: stats.mtime,
            hash: null, // Calculate later if needed
            isZipArchive: false
          });
          flushDiscoveredFiles();
        }
      } else if (enableZipArchives && ext === '.zip') {
          // Scan inside ZIP using same scanExtensions
        // ZIP files still need stat for size check
        const stats = await fs.promises.stat(filePath);
        if (stats.size <= maxFileSize) {
          const zipFiles = await scanZipFile(filePath, maxFileSize, extSet);
          files.push(...zipFiles);
          flushDiscoveredFiles();
        }
      }
      // For all other files, do nothing - no stat() call!
    } catch (error) {
      console.error(`Error processing file ${filePath}:`, error);
    }
  };

  // Start processing
  processNext();

  return donePromise;
}

  async function scanZipFile(zipPath, maxFileSize, extSet = new Set(['.stl', '.3mf'])) {
    const files = [];
  let zip = null;
    try {
    // Ensure StreamZip is loaded
      const StreamZipClass = loadStreamZip();
    zip = new StreamZipClass.async({ file: zipPath });
    const entries = await zip.entries();
    
    for (const entry of Object.values(entries)) {
      if (!entry.isDirectory) {
        if (shouldSkipEntryPath(entry.name, scanExcludeNames)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (extSet.has(ext)) {
          if (entry.size <= maxFileSize) {
            // Use double colon format: zipPath::entryPath
            const filePath = `${zipPath}::${entry.name}`;
            // For zip entries, we can't easily calculate hash without extracting
            // Hash will be calculated later when the file is accessed
            files.push({
              filePath: filePath,
              fileName: entry.name,
              size: entry.size,
              mtime: entry.time ? new Date(entry.time) : new Date(),
              hash: null, // Hash calculated on-demand for zip entries
              isZipArchive: true,
              zipEntryPath: entry.name,
              zip_path: entry.name
            });
          }
        }
      }
    }
    
  } catch (error) {
    const errorMessage = error && error.message ? error.message : String(error);
    if (/invalid entry header|not a zip|end of central directory/i.test(errorMessage)) {
      // Invalid archives should be skipped without noisy stack traces.
      console.warn(`Skipping invalid ZIP archive ${zipPath}: ${errorMessage}`);
    } else {
      console.error(`Error scanning ZIP file ${zipPath}:`, error);
    }
  } finally {
    if (zip) {
      try {
        await zip.close();
      } catch {}
    }
  }
  
  return files;
}

// Only register the worker message handler when actually running inside a
// worker_threads Worker. When this file is require()'d directly (e.g. from a
// unit test, to exercise scanDirectory()/processDirectory() in-process),
// parentPort is null and this registration must be skipped - otherwise
// parentPort.on(...) throws immediately on require().
if (parentPort) {
  parentPort.on('message', async ({ directoryPath, maxFileSize, enableZipArchives, scanExtensions, excludeFolderNames, excludeDirectories, nodeModulesPath: passedNodeModulesPath }) => {
    scanExcludeNames = normalizeExcludeNames(excludeFolderNames);
    // Set the node_modules path if provided
    if (passedNodeModulesPath) {
      nodeModulesPath = passedNodeModulesPath;
      console.log(`[Worker] Received node_modules path: ${nodeModulesPath}`);
    }

    const extList = Array.from(buildScanExtensionSet(scanExtensions));

    // Load StreamZip only when ZIP archives are enabled (saves startup I/O on every scan).
    if (enableZipArchives) {
      try {
        loadStreamZip();
        if (!StreamZip) {
          throw new Error('loadStreamZip() returned without setting StreamZip');
        }
      } catch (error) {
        console.error(`[Worker] Error loading node-stream-zip:`, error);
        console.error(`[Worker] Error stack:`, error.stack);
        parentPort.postMessage({ type: 'error', error: `Failed to load node-stream-zip: ${error.message}` });
        return;
      }
    }
    try {
      const result = await scanDirectory(directoryPath, maxFileSize, enableZipArchives, extList, excludeDirectories);
      parentPort.postMessage({ type: 'done', result });
    } catch (error) {
      parentPort.postMessage({ type: 'error', error: error.message });
    }
  });
}

// Exported for direct require() in unit tests. Production usage (via
// new Worker('scan-worker.js')) is unaffected - this is additive.
module.exports = { scanDirectory };
