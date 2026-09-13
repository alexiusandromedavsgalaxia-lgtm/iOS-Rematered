// src/kernel/MemoryManager.js
// Virtual memory manager used by the simulated kernel.

export class MemoryManager {
  constructor(totalBytes = 4 * 1024 * 1024 * 1024) {
    this.total = Number.isFinite(totalBytes) && totalBytes > 0 ? Math.floor(totalBytes) : 4 * 1024 * 1024 * 1024;
    this.allocations = new Map();
    this.nextHandle = 1;
    this.used = 0;
    this.peak = 0;
    this.failed = 0;
  }

  allocate(bytes, owner = null, flags = {}) {
    const size = Math.max(1, Math.floor(Number(bytes) || 0));
    if (this.used + size > this.total) {
      this.failed += 1;
      const error = new Error(`out of memory: requested ${size} bytes`);
      error.code = 'ENOMEM';
      throw error;
    }
    const handle = this.nextHandle++;
    const allocation = {
      handle,
      size,
      owner,
      flags,
      allocatedAt: Date.now(),
    };
    this.allocations.set(handle, allocation);
    this.used += size;
    this.peak = Math.max(this.peak, this.used);
    return allocation;
  }

  free(handle, owner = null) {
    const id = typeof handle === 'object' && handle ? handle.handle : handle;
    const allocation = this.allocations.get(id);
    if (!allocation) return false;
    if (owner !== null && allocation.owner !== null && allocation.owner !== owner) return false;
    this.allocations.delete(id);
    this.used = Math.max(0, this.used - allocation.size);
    return true;
  }

  getStats() {
    return {
      total: this.total,
      used: this.used,
      free: this.total - this.used,
      peak: this.peak,
      allocations: this.allocations.size,
      failed: this.failed,
    };
  }

  reset() {
    this.allocations.clear();
    this.used = 0;
  }
}

export default MemoryManager;
