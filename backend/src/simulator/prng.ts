export class PRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed;
  }

  next(): number {
    this.state = (this.state * 1664525 + 1013904223) % 4294967296;
    return this.state / 4294967296;
  }

  nextRange(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.nextRange(min, max));
  }

  nextChoice<T>(arr: T[]): T {
    return arr[this.nextInt(0, arr.length)];
  }

  nextBoolean(probability = 0.5): boolean {
    return this.next() < probability;
  }
}
