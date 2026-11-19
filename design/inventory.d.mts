// The types of inventory.mjs, for the web UI's gallery check, which imports it.
export function designNames(
  componentsMd: string,
  screensMd: string,
): {
  inventory: string[];
  props: Record<string, string[]>;
  sections: string[];
  stateIds: string[];
  frames: string[];
};
