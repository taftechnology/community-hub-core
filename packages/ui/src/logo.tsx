import { cn } from "./lib/utils";

export interface LogoProps {
  variant: "outline-white" | "outline-teal";
  size?: number;
  label?: string;
  className?: string;
}

export function Logo({ variant, size = 30, label, className }: LogoProps) {
  const variantClass = variant === "outline-white" ? "text-sidebar-foreground" : "text-primary";
  const a11yProps = label
    ? { role: "img", "aria-label": label }
    : { "aria-hidden": "true" as const };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="58 47 927 927"
      fill="none"
      stroke="currentColor"
      strokeWidth="40"
      width={size}
      height={size}
      className={cn("shrink-0", variantClass, className)}
      {...a11yProps}
    >
      <circle cx="521.5" cy="368.5" r="288.5" />
      <circle cx="376.5" cy="510.5" r="288.5" />
      <circle cx="666.5" cy="510.5" r="288.5" />
      <circle cx="521.5" cy="652.5" r="288.5" />
    </svg>
  );
}
