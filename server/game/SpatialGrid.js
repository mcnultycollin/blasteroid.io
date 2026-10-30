/**
 * Uniform grid over the torus world, rebuilt every tick. Entities are
 * inserted into every cell their bounding box touches, so any two overlapping
 * circles always share a cell. Used for collision broad-phase and for
 * per-client interest queries. Queries skip dead entities.
 */
export class SpatialGrid {
  constructor(worldSize, cellSize) {
    if (worldSize % cellSize !== 0) throw new Error('world size must be a multiple of the cell size');
    this.cellSize = cellSize;
    this.cols = worldSize / cellSize;
    this.cells = Array.from({ length: this.cols * this.cols }, () => []);
    this.used = []; // indices of non-empty cells, so clear() is O(used)
    this.stamp = 0;
  }

  clear() {
    for (const i of this.used) this.cells[i].length = 0;
    this.used.length = 0;
  }

  insert(e) {
    const { cellSize, cols } = this;
    const r = e.radius;
    const x0 = Math.floor((e.x - r) / cellSize);
    const x1 = Math.min(Math.floor((e.x + r) / cellSize), x0 + cols - 1);
    const y0 = Math.floor((e.y - r) / cellSize);
    const y1 = Math.min(Math.floor((e.y + r) / cellSize), y0 + cols - 1);
    for (let cy = y0; cy <= y1; cy++) {
      const row = (((cy % cols) + cols) % cols) * cols;
      for (let cx = x0; cx <= x1; cx++) {
        const index = row + (((cx % cols) + cols) % cols);
        const cell = this.cells[index];
        if (cell.length === 0) this.used.push(index);
        cell.push(e);
      }
    }
  }

  /**
   * Appends to `out` each live entity matching `mask` whose cells overlap the
   * box centred on (x, y) with half extents (hw, hh). Each entity appears once.
   */
  query(x, y, hw, hh, mask, out) {
    const { cellSize, cols } = this;
    const stamp = ++this.stamp;
    const x0 = Math.floor((x - hw) / cellSize);
    const x1 = Math.min(Math.floor((x + hw) / cellSize), x0 + cols - 1);
    const y0 = Math.floor((y - hh) / cellSize);
    const y1 = Math.min(Math.floor((y + hh) / cellSize), y0 + cols - 1);
    for (let cy = y0; cy <= y1; cy++) {
      const row = (((cy % cols) + cols) % cols) * cols;
      for (let cx = x0; cx <= x1; cx++) {
        const cell = this.cells[row + (((cx % cols) + cols) % cols)];
        for (let i = 0; i < cell.length; i++) {
          const e = cell[i];
          if ((e.mask & mask) === 0 || e._q === stamp || e.dead) continue;
          e._q = stamp;
          out.push(e);
        }
      }
    }
    return out;
  }
}
