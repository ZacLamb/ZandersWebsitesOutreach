document.addEventListener("DOMContentLoaded", function () {
  var toggle = document.querySelector(".menu-toggle");
  var mobileNav = document.querySelector(".mobile-nav");

  if (toggle && mobileNav) {
    toggle.addEventListener("click", function () {
      toggle.classList.toggle("is-open");
      mobileNav.classList.toggle("is-open");
      document.body.style.overflow = mobileNav.classList.contains("is-open") ? "hidden" : "";
    });

    mobileNav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        toggle.classList.remove("is-open");
        mobileNav.classList.remove("is-open");
        document.body.style.overflow = "";
      });
    });
  }

  var revealEls = document.querySelectorAll(".reveal, .reveal-stagger");
  if ("IntersectionObserver" in window && revealEls.length) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -60px 0px" }
    );
    revealEls.forEach(function (el) { observer.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("is-visible"); });
  }

  var header = document.querySelector(".site-header");
  if (header) {
    var lastState = false;
    window.addEventListener("scroll", function () {
      var scrolled = window.scrollY > 12;
      if (scrolled !== lastState) {
        header.style.boxShadow = scrolled ? "0 8px 24px -18px rgba(34,6,13,0.5)" : "none";
        lastState = scrolled;
      }
    });
  }
});
