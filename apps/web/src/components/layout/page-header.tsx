import type React from 'react';
import { Link } from 'react-router';
import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The page header and the page body container.
 *
 * Every screen in Platter opens the same way: a large heading in the pixel display face, at
 * most one primary action to its right, then a hairline. Keeping that in one component is
 * what stops eight screens built by eight people from each inventing their own title size.
 *
 * The header is full-bleed inside the content region and owns its gutters, so the hairline
 * runs edge to edge. `PageBody` supplies the matching gutters for everything under it.
 */

/**
 * The Ghost primary control: a 32px-radius pill, 44px tall so it clears the minimum hit
 * target, with a 14px medium label. Exported for the rare case that needs the recipe
 * without the wrapper — prefer `<PageAction>`.
 */
export const pageActionClass = 'h-11 rounded-button px-5 text-subhead font-medium';

export interface PageActionProps extends Omit<ButtonProps, 'size' | 'asChild'> {
  /** Renders the action as a link, so it can be middle-clicked and opened in a new tab. */
  to?: string;
}

export function PageAction({ to, className, children, isLoading, ...rest }: PageActionProps) {
  if (to && !isLoading && !rest.disabled) {
    return (
      <Button asChild className={cn(pageActionClass, className)} size="lg" {...rest}>
        <Link to={to}>{children}</Link>
      </Button>
    );
  }

  return (
    <Button
      className={cn(pageActionClass, className)}
      isLoading={isLoading ?? false}
      size="lg"
      {...rest}
    >
      {children}
    </Button>
  );
}

export interface PageHeaderProps {
  title: string;
  /** One line of context under the title. Keep it to a sentence. */
  description?: React.ReactNode;
  /** A breadcrumb or label above the title. */
  eyebrow?: React.ReactNode;
  /** Normally exactly one `<PageAction>`. Two is the ceiling. */
  actions?: React.ReactNode;
  /** Tabs, filters or a search row, rendered above the hairline. */
  children?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('border-b border-separator px-6 lg:px-12', className)}>
      <div className="mx-auto flex w-full max-w-(--pl-container-max) flex-col gap-4 pt-10 pb-8 lg:pt-14">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            {eyebrow ? (
              <div className="text-caption font-medium text-label-tertiary">{eyebrow}</div>
            ) : null}
            {/* h1 picks up the pixel face, display tracking and 1:1 leading from global.css. */}
            <h1 className="min-w-0 text-title-2 text-label sm:text-title-1">{title}</h1>
            {description ? (
              <p className="max-w-prose text-balance text-subhead text-label-secondary">
                {description}
              </p>
            ) : null}
          </div>

          {actions ? <div className="flex shrink-0 items-center gap-3">{actions}</div> : null}
        </div>

        {children}
      </div>
    </header>
  );
}

export interface PageBodyProps {
  children: React.ReactNode;
  /** Drops the centred max-width for screens that genuinely need the full width (console). */
  fullWidth?: boolean;
  className?: string;
}

export function PageBody({ children, fullWidth = false, className }: PageBodyProps) {
  return (
    <div className={cn('px-6 py-10 lg:px-12 lg:py-12', className)}>
      <div className={cn('mx-auto w-full', fullWidth ? null : 'max-w-(--pl-container-max)')}>
        {children}
      </div>
    </div>
  );
}
