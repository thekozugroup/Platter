import { ark } from "@ark-ui/react/factory";
import type React from "react";
import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

export const buttonVariants = tv({
  base: [
    "relative",
    "inline-flex shrink-0 items-center justify-center gap-2",
    "whitespace-nowrap font-medium text-sm",
    "rounded-lg",
    "transition-all",
    // `outline-none` here beats the app's global `:focus-visible` outline (a utility outranks
    // a base rule), so this ring is the *only* focus indicator on the most common control in
    // the product. Shark's 32% put it at 2.03:1 against the page — below the 3:1 floor for a
    // UI boundary, and on ghost/outline buttons the page is the only adjacent colour, so
    // nothing else carried the signal. 72% measures ~6.9:1 on white and ~6.5:1 on #0d0d0d.
    "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/72",
    // 40%, not Shark's 64%: at 64% a dark primary button still reads as enabled, so people
    // press it and nothing happens. See DESIGN.md §8.
    "disabled:pointer-events-none disabled:opacity-40",
    "data-disabled:pointer-events-none data-disabled:opacity-40",
    "aria-disabled:pointer-events-none aria-disabled:opacity-40",
    "data-[state=loading]:pointer-events-none",
    "aria-invalid:border-destructive aria-invalid:ring-destructive/24",
    "[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    "motion-reduce:transition-none!",
  ],
  variants: {
    variant: {
      default: [
        "bg-primary",
        "border border-transparent shadow-primary/24 shadow-sm",
        "text-primary-foreground",
        "hover:bg-primary/90",
        "focus-visible:border-background",
      ],
      outline: [
        "bg-transparent",
        "text-foreground",
        "border border-input shadow-sm/5",
        "hover:bg-accent hover:text-accent-foreground",
        "dark:bg-input/32 dark:hover:bg-input/64",
        "focus-visible:border-primary",
      ],
      destructive: [
        "bg-destructive",
        // Not `text-white`: dark lightens the red to #e5726a, where white is 3.02:1. The
        // token is white in light and ink in dark. See `--pl-danger-on`.
        "text-danger-on",
        "border border-transparent shadow-destructive/24 shadow-sm",
        "hover:bg-destructive/90",
        "focus-visible:border-background focus-visible:ring-destructive-foreground/72",
      ],
      secondary: [
        "bg-secondary",
        "text-secondary-foreground",
        "border border-transparent",
        "focus-visible:border-primary",
        "hover:bg-secondary/80",
      ],
      ghost: [
        "hover:bg-accent hover:text-accent-foreground",
        "border border-transparent",
        "focus-visible:border-primary",
      ],
      link: [
        "text-primary",
        "underline-offset-4",
        "border border-transparent",
        "hover:underline",
        "focus-visible:border-primary",
      ],
    },
    size: {
      xs: [
        "h-6",
        "gap-1.5",
        "px-2",
        "text-xs",
        "rounded-sm",
        "[&_svg:not([class*='size-'])]:size-2.5",
      ],
      sm: [
        "h-7",
        "px-2.5",
        "gap-1.5",
        "[&_svg:not([class*='size-'])]:size-3.5",
      ],
      md: ["h-8", "px-3", "py-2"],
      lg: ["h-9", "px-3.5"],
      xl: ["h-10", "text-base", "px-4"],
      "icon-xs": "size-6 rounded-sm",
      "icon-sm": "size-7",
      "icon-md": "size-8",
      "icon-lg": "size-9",
      "icon-xl": "size-10 [&_svg:not([class*='size-'])]:size-5",
    },
    clickEffect: {
      true: "active:not-aria-[haspopup]:scale-[0.98]",
    },
    pill: {
      true: [
        "rounded-full",
        "has-[>svg]:data-[size=xs]:pe-3",
        "has-[>svg]:data-[size=sm]:pe-3.5",
        "has-[>svg]:data-[size=md]:pe-4",
        "has-[>svg]:data-[size=lg]:pe-4.5",
        "has-[>svg]:data-[size=xl]:pe-5",
      ],
    },
  },
  defaultVariants: {
    variant: "default",
    size: "md",
    clickEffect: true,
    pill: false,
  },
});

export interface ButtonProps
  extends React.ComponentProps<typeof ark.button>,
    VariantProps<typeof buttonVariants> {
  /**
   * Apply a click effect to the button
   *
   * @default true
   */
  clickEffect?: boolean;
  /**
   * Show a loading indicator
   *
   * @default false
   */
  isLoading?: boolean;
}

export const Button = (props: ButtonProps) => {
  const {
    variant = "default",
    size = "md",
    clickEffect = true,
    pill = false,
    isLoading = false,
    className,
    children,
    ...rest
  } = props;

  return (
    <ark.button
      className={cn(
        buttonVariants({ variant, size, clickEffect, pill }),
        className
      )}
      data-size={size}
      data-slot="button"
      data-state={isLoading ? "loading" : "idle"}
      data-variant={variant}
      type="button"
      {...rest}
      aria-busy={isLoading}
      aria-disabled={isLoading}
    >
      {isLoading ? (
        <>
          <span aria-hidden className="invisible">
            {children}
          </span>

          <span className="sr-only">{children}</span>

          <span className="absolute inset-0 flex items-center justify-center">
            <Spinner aria-hidden />
          </span>
        </>
      ) : (
        children
      )}
    </ark.button>
  );
};
