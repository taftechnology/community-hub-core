declare module "jsdom" {
  export class JSDOM {
    static fragment(html: string): DocumentFragment;
    constructor(html: string);
    window: { document: Document };
  }
}
