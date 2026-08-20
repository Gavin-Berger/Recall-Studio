import type { ParameterObj } from "../../../types/schema";

export function flattenCheckpointParameters(parameters: ParameterObj[]): ParameterObj[] {
  const flattened: ParameterObj[] = [];
  const visit = (items: ParameterObj[]) => {
    for (const parameter of items) {
      flattened.push(parameter);
      if (parameter.children.length > 0) visit(parameter.children);
    }
  };
  visit(parameters);
  return flattened;
}

export function checkpointValue(
  parameter: ParameterObj,
  value: number | null,
  display: string | null,
): string {
  if (display?.trim()) return display;
  if (value === null) return "Not reported";
  if (parameter.is_quantized && parameter.value_items.length > 0) {
    const index = Math.round(value - (parameter.min ?? 0));
    if (index >= 0 && index < parameter.value_items.length) return parameter.value_items[index];
  }
  return Number.isInteger(value) ? String(value) : Number(value.toPrecision(5)).toString();
}
