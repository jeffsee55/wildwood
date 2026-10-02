import { createHash } from "node:crypto";

// Stable labels also give drafts created before names existed a readable name.
// Names are presentation only; IDs remain the authority for all operations.
export function draftName(id: string): string {
  const bytes = createHash("sha256").update(id).digest();
  const moods = [
    "Quiet",
    "Bright",
    "Gentle",
    "Golden",
    "Misty",
    "Sunny",
    "Silver",
    "Wild",
    "Soft",
    "Still",
    "Little",
    "Hidden",
    "Dancing",
    "Wandering",
    "Peaceful",
    "Dappled",
  ];
  const plants = [
    "Amber",
    "Willow",
    "Cedar",
    "Maple",
    "Birch",
    "Laurel",
    "Aspen",
    "Hazel",
    "Juniper",
    "Fern",
    "Moss",
    "Clover",
    "Pine",
    "Sage",
    "Ivy",
    "Oak",
  ];
  const places = [
    "Grove",
    "Meadow",
    "Trail",
    "Garden",
    "Valley",
    "Brook",
    "Hollow",
    "Ridge",
    "Glade",
    "Field",
    "Hill",
    "Creek",
    "Wood",
    "Clearing",
    "Orchard",
    "Glen",
  ];
  return `${moods[bytes[0] % moods.length]} ${plants[bytes[1] % plants.length]} ${places[bytes[2] % places.length]}`;
}
