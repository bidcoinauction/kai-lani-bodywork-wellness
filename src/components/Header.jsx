import { useEffect, useState } from "react";
import { logoSrc } from "../data.js";

export default function Header() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    document.body.classList.toggle("nav-open", isOpen);
    return () => document.body.classList.remove("nav-open");
  }, [isOpen]);

  const closeNav = () => setIsOpen(false);

  return (
    <header className="site-header" data-header>
      <a className="brand-mark" href="#top" aria-label="Kai Lani home" onClick={closeNav}>
        <img src={logoSrc} alt="" />
        <span>Kai Lani</span>
      </a>
      <button
        className="nav-toggle"
        type="button"
        aria-label="Open navigation"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span></span>
        <span></span>
      </button>
      <nav className="site-nav" data-nav>
        <a href="#services" onClick={closeNav}>Services</a>
        <a href="#experience" onClick={closeNav}>Experience</a>
        <a href="#booking" onClick={closeNav}>Book</a>
        <a href="#visit" onClick={closeNav}>Visit</a>
      </nav>
    </header>
  );
}
