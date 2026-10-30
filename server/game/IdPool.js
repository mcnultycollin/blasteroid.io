/**
 * FIFO pool of 16-bit ids. Released ids go to the back of the queue, so an id
 * is reused only after every other free id has been handed out. That keeps
 * stale references on clients from ever colliding with a fresh entity.
 */
export class IdPool {
  constructor(first, last) {
    this.capacity = last - first + 1;
    this.free = new Uint16Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.free[i] = first + i;
    this.head = 0;
    this.size = this.capacity;
  }

  /** Returns a free id, or 0 when the pool is exhausted. */
  alloc() {
    if (this.size === 0) return 0;
    const id = this.free[this.head];
    this.head = (this.head + 1) % this.capacity;
    this.size--;
    return id;
  }

  release(id) {
    this.free[(this.head + this.size) % this.capacity] = id;
    this.size++;
  }
}
