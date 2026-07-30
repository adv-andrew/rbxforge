import type { ButtonProps } from "./Button.js";
import type { IconButtonProps } from "./IconButton.js";
import type { InputProps } from "./Input.js";
import type { StatusChipProps } from "./StatusChip.js";

type AssertFalse<Value extends false> = Value;
type AssertTrue<Value extends true> = Value;
type HasStyle<Props> = "style" extends keyof Props ? true : false;
type IsNever<Value> = [Value] extends [never] ? true : false;

export type ButtonStyleIsAbsent = AssertFalse<HasStyle<ButtonProps>>;
export type IconButtonStyleIsAbsent = AssertFalse<HasStyle<IconButtonProps<"Close">>>;
export type InputStyleIsAbsent = AssertFalse<HasStyle<InputProps>>;
export type EmptyStatusLabelIsRejected = AssertTrue<IsNever<StatusChipProps<"">["label"]>>;
