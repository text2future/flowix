import * as React from "react";
import { cn } from "@/lib/utils";
import { DialogAppearanceContext } from "./dialog-appearance-context";
import { INPUT_CLASS, DIALOG_INPUT_CLASS } from "./input-styles";

const NON_TEXT_INPUT_TYPES = new Set(["checkbox", "radio", "file", "hidden", "range", "color", "button", "submit", "reset"]);

export interface InputProps
	extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
	({ className, type, ...props }, ref) => {
		const inDialog = React.useContext(DialogAppearanceContext);
		const textField = !NON_TEXT_INPUT_TYPES.has(type ?? "text");
		return (
			<input
				type={type}
				className={cn(
					INPUT_CLASS,
					className,
					inDialog && textField && DIALOG_INPUT_CLASS
				)}
				ref={ref}
				{...props}
			/>
		);
	}
);
Input.displayName = "Input";

export { Input };
