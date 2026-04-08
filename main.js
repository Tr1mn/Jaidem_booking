const yearNode = document.querySelector("#year");

if (yearNode) {
  yearNode.textContent = String(new Date().getFullYear());
}

const revealObserver = new IntersectionObserver(
  entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) {
        return;
      }

      entry.target.classList.add("is-visible");
      revealObserver.unobserve(entry.target);
    });
  },
  {
    threshold: 0.2
  }
);

document.querySelectorAll("[data-reveal]").forEach(node => {
  revealObserver.observe(node);
});

const navLinks = [...document.querySelectorAll(".topnav a")];
const sectionTargets = navLinks
  .map(link => document.querySelector(link.getAttribute("href")))
  .filter(Boolean);

const navObserver = new IntersectionObserver(
  entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) {
        return;
      }

      navLinks.forEach(link => {
        const isActive = link.getAttribute("href") === `#${entry.target.id}`;
        link.classList.toggle("is-active", isActive);
      });
    });
  },
  {
    rootMargin: "-35% 0px -45% 0px",
    threshold: 0
  }
);

sectionTargets.forEach(section => {
  navObserver.observe(section);
});
