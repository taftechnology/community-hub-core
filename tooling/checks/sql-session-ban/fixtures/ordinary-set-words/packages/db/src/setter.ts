export class Community {
  #value = "";

  set value(v: string) {
    this.#value = v;
  }

  get value(): string {
    return this.#value;
  }
}
