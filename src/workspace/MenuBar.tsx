import { useEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onClick?: () => void;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

export interface Menu {
  label: string;
  items: MenuItem[];
}

/** VS Code-style menu bar: click to open, hover to switch menus, click outside to close. */
export default function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="menubar" ref={ref}>
      {menus.map((menu, i) => (
        <div key={menu.label} className="menubar-menu">
          <button
            className={`menubar-title${open === i ? " active" : ""}`}
            onClick={() => setOpen(open === i ? null : i)}
            onMouseEnter={() => open !== null && setOpen(i)}
          >
            {menu.label}
          </button>
          {open === i && (
            <div className="menubar-dropdown">
              {menu.items.map((item, j) =>
                item.separator ? (
                  <div key={j} className="menubar-separator" />
                ) : (
                  <button
                    key={j}
                    className="menubar-item"
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(null);
                      item.onClick?.();
                    }}
                  >
                    <span className="menubar-check">{item.checked ? "✓" : ""}</span>
                    {item.label}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
