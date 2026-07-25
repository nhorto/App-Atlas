/** @fileoverview Buttons and other shared pieces. */
export interface ButtonProps {
  label: string;
}

export function Button(props: ButtonProps): string {
  return props.label;
}
