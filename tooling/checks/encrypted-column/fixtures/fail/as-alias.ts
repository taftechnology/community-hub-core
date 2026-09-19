import { people } from "../table.js";

export function run(): void {
  people.payload.as("enc");
}
