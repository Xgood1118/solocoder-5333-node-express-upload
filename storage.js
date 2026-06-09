const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const config = require('./config');

const mkdir = promisify(fs.mkdir);
const stat = promisify(fs.stat);
const unlink = promisify(fs.unlink);
const readdir = promisify(fs.readdir);
const rmdir = promisify(fs.rmdir);
const access = promisify(fs.access);

class Storage {
  constructor() {
    this.uploadDir = config.uploadDir;
    this.chunkDir = config.chunkDir;
    this.dataDir = config.dataDir;
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return;
    await Promise.all([
      this._ensureDir(this.uploadDir),
      this._ensureDir(this.chunkDir),
      this._ensureDir(this.dataDir)
    ]);
    this._initialized = true;
  }

  async _ensureDir(dir) {
    try {
      await access(dir, fs.constants.W_OK);
    } catch {
      await mkdir(dir, { recursive: true });
    }
  }

  getUploadPath(fileId) {
    return path.join(this.uploadDir, fileId);
  }

  getChunkDir(uploadId) {
    return path.join(this.chunkDir, uploadId);
  }

  getChunkPath(uploadId, index) {
    return path.join(this.getChunkDir(uploadId), String(index));
  }

  getDataPath(filename) {
    return path.join(this.dataDir, filename);
  }

  async saveChunk(uploadId, index, bufferOrStream) {
    const chunkDir = this.getChunkDir(uploadId);
    await this._ensureDir(chunkDir);
    const chunkPath = this.getChunkPath(uploadId, index);

    return new Promise((resolve, reject) => {
      if (Buffer.isBuffer(bufferOrStream)) {
        fs.writeFile(chunkPath, bufferOrStream, (err) => {
          if (err) reject(err);
          else resolve(chunkPath);
        });
      } else {
        const writeStream = fs.createWriteStream(chunkPath);
        bufferOrStream.pipe(writeStream);
        writeStream.on('finish', () => resolve(chunkPath));
        writeStream.on('error', reject);
      }
    });
  }

  async chunkExists(uploadId, index) {
    try {
      const chunkPath = this.getChunkPath(uploadId, index);
      await access(chunkPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async getChunkSize(uploadId, index) {
    try {
      const stats = await stat(this.getChunkPath(uploadId, index));
      return stats.size;
    } catch {
      return 0;
    }
  }

  async listChunks(uploadId) {
    const chunkDir = this.getChunkDir(uploadId);
    try {
      const files = await readdir(chunkDir);
      return files
        .filter(f => /^\d+$/.test(f))
        .map(f => parseInt(f, 10))
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  async mergeChunks(uploadId, totalChunks, destinationPath) {
    await this._ensureDir(path.dirname(destinationPath));

    return new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(destinationPath);
      let currentChunk = 0;

      const writeNext = () => {
        if (currentChunk >= totalChunks) {
          writeStream.end();
          return;
        }

        const chunkPath = this.getChunkPath(uploadId, currentChunk);
        const readStream = fs.createReadStream(chunkPath);

        readStream.pipe(writeStream, { end: false });
        readStream.on('end', () => {
          currentChunk++;
          writeNext();
        });
        readStream.on('error', (err) => {
          writeStream.destroy();
          reject(err);
        });
      };

      writeStream.on('finish', resolve);
      writeStream.on('error', reject);

      writeNext();
    });
  }

  async deleteChunks(uploadId) {
    const chunkDir = this.getChunkDir(uploadId);
    try {
      const files = await readdir(chunkDir);
      await Promise.all(files.map(f => unlink(path.join(chunkDir, f))));
      await rmdir(chunkDir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async deleteFile(filePath) {
    try {
      await unlink(filePath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  async fileExists(filePath) {
    try {
      await access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async getFileSize(filePath) {
    const stats = await stat(filePath);
    return stats.size;
  }

  createReadStream(filePath, options) {
    return fs.createReadStream(filePath, options);
  }

  createWriteStream(filePath) {
    return fs.createWriteStream(filePath);
  }

  async getDiskFreeSpace() {
    const checkPath = this.uploadDir;
    try {
      if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        const result = execSync(`fsutil volume diskfree "${path.dirname(checkPath)}"`).toString();
        const match = result.match(/可用字节总数:\s*(\d+)/);
        if (match) return parseInt(match[1], 10);
      } else {
        const { execSync } = require('child_process');
        const result = execSync(`df -B1 "${checkPath}" | tail -1`).toString();
        const parts = result.trim().split(/\s+/);
        return parseInt(parts[3], 10);
      }
    } catch {
      return Infinity;
    }
    return Infinity;
  }

  async readJSON(filePath) {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeJSON(filePath, data) {
    const tmpPath = filePath + '.tmp';
    await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rename(tmpPath, filePath);
  }
}

module.exports = new Storage();
