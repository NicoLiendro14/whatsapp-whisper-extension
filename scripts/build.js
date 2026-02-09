#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const CHROME_DIR = path.join(DIST_DIR, 'chrome');

// Files and directories to include in the extension
const EXTENSION_FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'injected.js',
  'popup.html',
  'popup.js',
  'styles.css',
  'icons'
];

/**
 * Recursively delete a directory
 */
function rimraf(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

/**
 * Recursively copy a directory
 */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Copy a file or directory
 */
function copy(src, dest) {
  const stat = fs.statSync(src);
  
  if (stat.isDirectory()) {
    copyDir(src, dest);
  } else {
    fs.copyFileSync(src, dest);
  }
}

/**
 * Create a ZIP archive from a directory
 */
function createZip(sourceDir, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => {
      const sizeKB = (archive.pointer() / 1024).toFixed(2);
      console.log(`📦 ZIP created: ${path.basename(outputPath)} (${sizeKB} KB)`);
      resolve();
    });
    
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

/**
 * Main build function
 */
async function build() {
  console.log('🔨 Building Chrome extension...\n');
  
  // Read version from manifest
  const manifestPath = path.join(ROOT_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = manifest.version;
  
  console.log(`📋 Extension: ${manifest.name}`);
  console.log(`📋 Version: ${version}\n`);
  
  // Clean dist/chrome directory
  console.log('🧹 Cleaning dist/chrome...');
  rimraf(CHROME_DIR);
  fs.mkdirSync(CHROME_DIR, { recursive: true });
  
  // Copy extension files
  console.log('📁 Copying files...');
  for (const file of EXTENSION_FILES) {
    const src = path.join(ROOT_DIR, file);
    const dest = path.join(CHROME_DIR, file);
    
    if (fs.existsSync(src)) {
      copy(src, dest);
      console.log(`   ✓ ${file}`);
    } else {
      console.warn(`   ⚠ ${file} not found, skipping`);
    }
  }
  
  // Create ZIP
  console.log('\n📦 Creating ZIP archive...');
  const zipName = `extension-chrome-v${version}.zip`;
  const zipPath = path.join(DIST_DIR, zipName);
  
  await createZip(CHROME_DIR, zipPath);
  
  console.log('\n✅ Build complete!');
  console.log(`   📂 dist/chrome/`);
  console.log(`   📦 dist/${zipName}`);
}

// Run build
build().catch((err) => {
  console.error('❌ Build failed:', err);
  process.exit(1);
});
