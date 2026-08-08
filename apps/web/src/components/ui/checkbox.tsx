"use client";

import {
  Checkbox as ArkCheckbox,
  useCheckboxContext,
} from "@ark-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "@/components/common/icons";
import type React from "react";
import { tv } from "tailwind-variants";
import { cn } from "@/lib/utils";

export const useCheckbox = useCheckboxContext;

export const CheckboxGroup = (
  props: React.ComponentProps<typeof ArkCheckbox.Group>
) => {
  const { className, ...rest } = props;

  return (
    <ArkCheckbox.Group
      className={cn("flex flex-col gap-2", className)}
      data-slot="checkbox-group"
      {...rest}
    />
  );
};

export const checkboxVariants = tv({
  base: [
    "relative",
    "inline-flex shrink-0 items-center justify-center",
    "size-4",
    "bg-transparent",
    "rounded-sm border border-input shadow-xs/5",
    "transition-shadow",
    "data-focus-visible:border-primary data-focus-visible:ring-[3px] data-focus-visible:ring-ring/32 data-focus-visible:ring-offset-1 data-focus-visible:ring-offset-background",
    "dark:data-focus-visible:data-invalid:border-destructive-foreground/64 dark:data-focus-visible:data-invalid:ring-destructive-foreground/48",
    "data-disabled:opacity-64",
    "[[data-disabled],[data-checked],[data-invalid]]:shadow-none",
    "data-invalid:border-destructive data-invalid:ring-[3px] data-invalid:ring-destructive/24",
    "dark:data-invalid:border-destructive-foreground dark:data-invalid:text-destructive-foreground dark:data-invalid:ring-destructive-foreground/20",
    "dark:not-data-checked:bg-input/32 dark:data-invalid:ring-destructive-foreground/24",
    "motion-reduce:transition-none!",
  ],
});

/**
 * Ark renders the root as a real `<label htmlFor>` wrapping a visually-hidden
 * `<input type="checkbox">` — the input is the control, the root is its label.
 *
 * Three things had to change for that to reach assistive tech:
 *
 * 1. **`role="checkbox"` is gone from the root.** It turned the label into a *second*,
 *    permanently nameless checkbox in the accessibility tree, so every one of these
 *    reported twice — once unnamed, once real.
 * 2. **`id` is routed to the hidden input** via Ark's `ids`. Ark otherwise re-keys a bare
 *    `id` to `checkbox:<id>`, which left every caller's `<label htmlFor={id}>` pointing at
 *    an element that does not exist: no name, and clicking the word did nothing.
 * 3. **`aria-label` / `aria-labelledby` / `aria-describedby` land on the input**, not on
 *    the label, because that is the element a screen reader announces.
 *
 * Ark always sets `aria-labelledby` on the input pointing at its `Label` part. This
 * component does not render one, so that reference dangles — which is fine and deliberate:
 * an `aria-labelledby` whose traversal is empty is skipped and the accessible name falls
 * through to the associated `<label>`, verified in Chrome. Rendering an empty `Label` here
 * would instead style a stray element into every call site.
 */
export interface CheckboxProps
  extends React.ComponentProps<typeof ArkCheckbox.Root> {}

export const Checkbox = (props: CheckboxProps) => {
  const {
    className,
    tabIndex,
    id,
    ids,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledby,
    "aria-describedby": ariaDescribedby,
    ...rest
  } = props;

  return (
    <ArkCheckbox.Root
      className={cn(checkboxVariants(), className)}
      data-slot="checkbox"
      ids={{ ...(id === undefined ? {} : { hiddenInput: id }), ...ids }}
      {...rest}
    >
      <ArkCheckbox.Control data-slot="checkbox-control">
        <CheckboxIndicator>
          <CheckIcon />
        </CheckboxIndicator>

        <CheckboxIndicator indeterminate>
          <MinusIcon />
        </CheckboxIndicator>
      </ArkCheckbox.Control>

      <ArkCheckbox.HiddenInput
        aria-describedby={ariaDescribedby}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        tabIndex={tabIndex}
      />
    </ArkCheckbox.Root>
  );
};

export const CheckboxIndicator = (
  props: React.ComponentProps<typeof ArkCheckbox.Indicator>
) => {
  const { className, ...rest } = props;

  return (
    <ArkCheckbox.Indicator
      className={cn(
        "absolute -inset-px",
        "flex items-center justify-center",
        "rounded-sm",
        "text-primary-foreground",
        "data-[state=checked]:bg-primary",
        "data-[state=unchecked]:hidden",
        "data-[state=indeterminate]:text-foreground",
        className
      )}
      data-slot="checkbox-indicator"
      {...rest}
    />
  );
};
