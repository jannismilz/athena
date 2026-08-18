// ============================================================================
// athena.js: Wiki.js custom JS
// - make tables sortable, using Tablesort
// - drive the sort arrows
// - make the table of contents collapsible
// - add a print button to the header
// - open browse folders that have an overview page
// ============================================================================

(function () {
  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  onReady(function () {
    // ------------------------------------------------------------
    // 1) Make tables sortable
    // ------------------------------------------------------------
    try {
      document.querySelectorAll('.contents table').forEach(function (table) {
        // Tablesort initialisieren, falls Lib geladen ist
        if (typeof Tablesort !== 'undefined') {
          new Tablesort(table);
        }

        // Intercept the header click and set our own sort classes so the
        // CSS arrows render the right way round.
        table.querySelectorAll('thead th').forEach(function (th) {
          th.addEventListener('click', function () {
            var current = th.getAttribute('data-sort-dir') || 'none';
            var next = current === 'asc' ? 'desc' : 'asc';

            // Alle Header im Tisch zurücksetzen
            table.querySelectorAll('thead th').forEach(function (h) {
              h.removeAttribute('data-sort-dir');
              h.classList.remove('sorted-asc', 'sorted-desc');
            });

            // Neue Richtung setzen
            th.setAttribute('data-sort-dir', next);
            th.classList.add(next === 'asc' ? 'sorted-asc' : 'sorted-desc');
          });
        });
      });
    } catch (e) {
      console.error('athena.js: table setup failed:', e);
    }

    // ------------------------------------------------------------
    // 2) Sidebarn: Inhaltsverzeichnis einklappbar
    // ------------------------------------------------------------
    try {
      var tocCard = document.querySelector('.page-toc-card');
      if (tocCard) {
        var tocHeader = tocCard.querySelector('.overline');
        if (tocHeader) {
          tocHeader.style.cursor = 'pointer';
          tocHeader.addEventListener('click', function () {
            tocCard.classList.toggle('athena-collapsed');
          });
        }
      }
    } catch (e) {
      console.error('athena.js: table-of-contents setup failed:', e);
    }

    // ------------------------------------------------------------
    // 3) Print: move the action into the header
    // The original button in .page-shortcuts-card stays in the DOM
    // (Wiki.js printView). The original card is hidden via CSS.
    // ------------------------------------------------------------
    try {
      function toolbarChild(el) {
        var toolbar = el.closest('.v-toolbar__content');
        if (!toolbar) return el;
        var node = el;
        while (node.parentElement && node.parentElement !== toolbar) {
          node = node.parentElement;
        }
        return node;
      }

      function insertPrintInHeader() {
        if (document.querySelector('.athena-header-print')) return true;
        var srcIcon = document.querySelector('.page-shortcuts-card .mdi-printer');
        if (!srcIcon) return false;
        var srcBtn = srcIcon.closest('button, .v-btn, a');
        if (!srcBtn) return false;

        var header = document.querySelector('.nav-header');
        if (!header) return false;
        var newPageIcon = header.querySelector('.mdi-text-box-plus-outline');
        var adminIcon = header.querySelector('.mdi-cog');
        var before = adminIcon
          ? toolbarChild(adminIcon)
          : newPageIcon
            ? toolbarChild(newPageIcon).nextSibling
            : null;
        var parent = before && before.parentElement;
        if (!parent) return false;

        var refBtn = newPageIcon && newPageIcon.closest('.v-btn');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = (refBtn ? refBtn.className : 'v-btn v-btn--flat v-btn--icon v-btn--tile theme--dark v-size--default') + ' athena-header-print';
        btn.style.height = (refBtn && refBtn.style.height) || '64px';
        btn.setAttribute('aria-label', srcBtn.getAttribute('aria-label') || 'Druckformat');
        btn.title = btn.getAttribute('aria-label');
        btn.innerHTML =
          '<span class="v-btn__content"><i aria-hidden="true" class="v-icon notranslate mdi mdi-printer theme--dark grey--text"></i></span>';
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          srcBtn.click();
        });

        var divider = document.createElement('hr');
        divider.setAttribute('role', 'separator');
        divider.setAttribute('aria-orientation', 'vertical');
        var existingDivider = parent.querySelector('.v-divider.v-divider--vertical');
        divider.className = existingDivider
          ? existingDivider.className
          : 'v-divider v-divider--vertical theme--dark';

        parent.insertBefore(btn, before);
        parent.insertBefore(divider, before);
        return true;
      }

      var printStarted = Date.now();
      var printWait = setInterval(function () {
        if (insertPrintInHeader() || Date.now() - printStarted > 8000) {
          clearInterval(printWait);
        }
      }, 100);

      if (typeof MutationObserver === 'function') {
        var printObs = new MutationObserver(function () {
          if (insertPrintInHeader()) printObs.disconnect();
        });
        printObs.observe(document.body, { childList: true, subtree: true });
        setTimeout(function () {
          printObs.disconnect();
        }, 8000);
      }
    } catch (e) {
      console.error('athena.js: print button failed:', e);
    }

    // ------------------------------------------------------------
    // 4) Browse tree: also navigate to folders that have an overview page
    // Wiki.js only opens folders in the sidebar and resets the tree
    // to the root after a page change, so after the click we load the
    // page and then keep reopening the folder until it stays open.
    // Keep expanding until the child pages are visible.
    // ------------------------------------------------------------
    try {
      var skipFolderNavigate = false;
      var expandLockUntil = 0;
      var EXPAND_KEY = 'athena-expand-path';

      function drawer() {
        return document.querySelector('.v-navigation-drawer');
      }

      function canonicalPath(pathname) {
        var p = (pathname || '').replace(/\/+$/, '') || '/';
        return p.replace(/^\/[a-z]{2}(?=\/)/, '') || '/';
      }

      function currentPath() {
        return canonicalPath(location.pathname);
      }

      function hrefPath(href) {
        if (!href) return '';
        return canonicalPath(new URL(href, location.origin).pathname);
      }

      function itemHref(item) {
        if (!item) return '';
        return item.getAttribute('href') || '';
      }

      function directoryPageLink() {
        var root = drawer();
        if (!root) return null;
        var items = root.querySelectorAll('.v-list-item.mt-2[href]');
        for (var i = 0; i < items.length; i++) {
          if (items[i].querySelector('.mdi-text-box')) return items[i];
        }
        return null;
      }

      function folderRow(el) {
        var item = el && el.closest ? el.closest('.v-list-item') : null;
        if (!item || itemHref(item)) return null;
        if (!item.querySelector('.mdi-folder')) return null;
        if (item.querySelector('.mdi-folder-open')) return null;
        return item;
      }

      function pageTitle() {
        var el =
          document.querySelector('.page-header-headings .headline') ||
          document.querySelector('.contents h1');
        return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
      }

      function labelText(item) {
        var label = item.querySelector('.v-list-item__title, .v-list-item-title');
        if (label) return label.textContent.replace(/\s+/g, ' ').trim();
        return item.textContent.replace(/\s+/g, ' ').trim();
      }

      function isInsideCurrentOverview() {
        var link = directoryPageLink();
        return !!(link && hrefPath(itemHref(link)) === currentPath());
      }

      function matchingCollapsedFolder() {
        var title = pageTitle();
        var root = drawer();
        if (!title || !root) return null;
        var items = root.querySelectorAll('.v-list-item');
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          if (itemHref(item)) continue;
          if (!item.querySelector('.mdi-folder') || item.querySelector('.mdi-folder-open')) continue;
          if (labelText(item) === title) return item;
        }
        return null;
      }

      function tickExpand() {
        if (isInsideCurrentOverview()) {
          try {
            sessionStorage.removeItem(EXPAND_KEY);
          } catch (e) {}
          return true;
        }
        var want = null;
        try {
          want = sessionStorage.getItem(EXPAND_KEY);
        } catch (e) {}
        if (want && want !== currentPath()) return false;
        if (Date.now() < expandLockUntil) return false;
        var item = matchingCollapsedFolder();
        if (!item) return false;
        skipFolderNavigate = true;
        expandLockUntil = Date.now() + 700;
        item.click();
        setTimeout(function () {
          skipFolderNavigate = false;
        }, 700);
        return false;
      }

      document.addEventListener(
        'click',
        function (e) {
          if (skipFolderNavigate) return;
          if (!folderRow(e.target)) return;
          var started = Date.now();
          var timer = setInterval(function () {
            var link = directoryPageLink();
            if (link) {
              clearInterval(timer);
              var href = itemHref(link);
              if (href && hrefPath(href) !== currentPath()) {
                try {
                  sessionStorage.setItem(EXPAND_KEY, hrefPath(href));
                } catch (err) {}
                location.assign(href);
              }
            } else if (Date.now() - started > 2500) {
              clearInterval(timer);
            }
          }, 50);
        },
        true
      );

      var startedAt = Date.now();
      var wait = setInterval(function () {
        if (tickExpand() || Date.now() - startedAt > 8000) {
          clearInterval(wait);
        }
      }, 100);

      if (typeof MutationObserver === 'function') {
        var obs = new MutationObserver(function () {
          if (tickExpand()) obs.disconnect();
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(function () {
          obs.disconnect();
        }, 8000);
      }
    } catch (e) {
      console.error('athena.js: folder navigation failed:', e);
    }
  });
})();
