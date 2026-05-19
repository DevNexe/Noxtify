/**
 * Universal Hamburger Menu Logic
 * Добавьте этот код в ваш app.js
 * 
 * Поведение:
 * - На ПК (>768px): скрывает/показывает сайдбар (toggle)
 * - На мобильных (≤768px): открывает сайдбар поверх контента (overlay)
 */

class HamburgerMenuManager {
  constructor() {
    this.hamburgerBtn = document.getElementById('btn-hamburger');
    this.sidebarCloseBtn = document.getElementById('btn-sidebar-close');
    this.sidebar = document.getElementById('sidebar');
    this.layout = document.getElementById('layout');
    this.main = document.getElementById('main');
    
    this.isMobile = window.innerWidth <= 768;
    this.isOpen = false;
    this.isDesktopHidden = false;
    
    this.init();
  }

  init() {
    if (!this.hamburgerBtn || !this.sidebar) return;

    // Обработчик клика на гамбургер-кнопку
    this.hamburgerBtn.addEventListener('click', () => this.toggleMenu());

    // Обработчик клика на кнопку закрытия в сайдбаре
    if (this.sidebarCloseBtn) {
      this.sidebarCloseBtn.addEventListener('click', () => {
        if (this.isMobile && this.isOpen) {
          this.closeMobileMenu();
        }
      });
    }

    // Обработчик изменения размера окна
    window.addEventListener('resize', () => this.handleResize());

    // Закрытие меню при клике на контент (только на мобильных)
    if (this.main) {
      this.main.addEventListener('click', () => {
        if (this.isMobile && this.isOpen) {
          this.closeMobileMenu();
        }
      });
    }

    // Обработчик клика на иконку навигации (закрытие меню на мобильных)
    const navButtons = this.sidebar.querySelectorAll('.sidebar-icon');
    navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        if (this.isMobile && this.isOpen) {
          this.closeMobileMenu();
        }
      });
    });

    // Предотвращение закрытия при клике на самом сайдбаре
    this.sidebar.addEventListener('click', (e) => e.stopPropagation());

    // Обработка свайпа для закрытия сайдбара
    this.setupSwipeGestures();

    // Обработка клавиши Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen && this.isMobile) {
        this.closeMobileMenu();
      }
    });

    // Инициальная настройка
    this.updateMode();
  }

  toggleMenu() {
    if (this.isMobile) {
      // На мобильных: toggle overlay
      if (this.isOpen) {
        this.closeMobileMenu();
      } else {
        this.openMobileMenu();
      }
    } else {
      // На десктопе: toggle раскрытого состояния (expanded)
      if (this.isDesktopExpanded) {
        this.collapseDesktopSidebar();
      } else {
        this.expandDesktopSidebar();
      }
    }
  }

  // ── МОБИЛЬНЫЙ РЕЖИМ ──

  openMobileMenu() {
    if (!this.isMobile) return;

    this.isOpen = true;
    this.sidebar.classList.add('mobile-open');
    this.hamburgerBtn.classList.add('active');

    // Добавляем overlay для закрытия при клике
    this.addOverlay();

    // Предотвращаем скролл тела страницы
    document.body.style.overflow = 'hidden';
  }

  closeMobileMenu() {
    if (!this.isMobile) return;

    this.isOpen = false;
    this.sidebar.classList.remove('mobile-open');
    this.hamburgerBtn.classList.remove('active');

    // Удаляем overlay
    this.removeOverlay();

    // Восстанавливаем скролл
    document.body.style.overflow = '';
  }

  addOverlay() {
    // Проверяем, не существует ли уже overlay
    if (document.getElementById('sidebar-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'sidebar-overlay';

    overlay.addEventListener('click', () => this.closeMobileMenu());
    document.body.appendChild(overlay);
  }

  removeOverlay() {
    const overlay = document.getElementById('sidebar-overlay');
    if (overlay) {
      overlay.style.animation = 'fadeOut 0.3s ease';
      setTimeout(() => overlay.remove(), 300);
    }
  }

  // ── ДЕСКТОПНЫЙ РЕЖИМ ──

  collapseDesktopSidebar() {
    if (this.isMobile) return;

    this.isDesktopExpanded = false;
    this.sidebar.classList.remove('sidebar-expanded');
    this.hamburgerBtn.classList.remove('active');

    // Сохраняем состояние в localStorage
    localStorage.setItem('sidebar-expanded', 'false');
  }

  expandDesktopSidebar() {
    if (this.isMobile) return;

    this.isDesktopExpanded = true;
    this.sidebar.classList.add('sidebar-expanded');
    this.hamburgerBtn.classList.add('active');

    // Сохраняем состояние в localStorage
    localStorage.setItem('sidebar-expanded', 'true');
  }

  // ── ОБЩИЕ МЕТОДЫ ──

  handleResize() {
    const wasMobile = this.isMobile;
    this.isMobile = window.innerWidth <= 768;

    // Если переходим с мобильного на десктоп
    if (wasMobile && !this.isMobile) {
      this.closeMobileMenu();
      this.sidebar.classList.remove('mobile-open');
      document.body.style.overflow = '';
      
      // Восстанавливаем сохраненное состояние десктопа
      const wasSidebarExpanded = localStorage.getItem('sidebar-expanded') === 'true';
      if (wasSidebarExpanded) {
        this.expandDesktopSidebar();
      } else {
        this.collapseDesktopSidebar();
      }
    }

    // Если переходим с десктопа на мобильный
    if (!wasMobile && this.isMobile) {
      this.sidebar.classList.remove('sidebar-expanded');
      this.hamburgerBtn.classList.remove('active');
      this.isDesktopExpanded = false;
    }

    this.updateMode();
  }

  updateMode() {
    if (this.isMobile) {
      // Мобильный режим: сайдбар по умолчанию скрыт
      this.sidebar.classList.remove('sidebar-expanded');
      if (!this.isOpen) {
        this.sidebar.classList.remove('mobile-open');
        this.hamburgerBtn.classList.remove('active');
      }
    } else {
      // Десктопный режим: восстанавливаем сохраненное состояние
      this.sidebar.classList.remove('mobile-open');
      const wasSidebarExpanded = localStorage.getItem('sidebar-expanded') === 'true';
      if (wasSidebarExpanded) {
        this.sidebar.classList.add('sidebar-expanded');
        this.hamburgerBtn.classList.add('active');
        this.isDesktopExpanded = true;
      } else {
        this.sidebar.classList.remove('sidebar-expanded');
        this.hamburgerBtn.classList.remove('active');
        this.isDesktopExpanded = false;
      }
    }
  }

  setupSwipeGestures() {
    let touchStartX = 0;
    let touchEndX = 0;

    document.addEventListener('touchstart', (e) => {
      touchStartX = e.changedTouches[0].screenX;
    }, false);

    document.addEventListener('touchend', (e) => {
      touchEndX = e.changedTouches[0].screenX;
      this.handleSwipe(touchStartX, touchEndX);
    }, false);
  }

  handleSwipe(startX, endX) {
    if (!this.isMobile) return;

    const swipeThreshold = 50;
    const diff = startX - endX;

    // Свайп влево - закрыть сайдбар
    if (diff > swipeThreshold && this.isOpen) {
      this.closeMobileMenu();
    }

    // Свайп вправо - открыть сайдбар
    if (diff < -swipeThreshold && !this.isOpen) {
      this.openMobileMenu();
    }
  }
}

// Инициализируем при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
  new HamburgerMenuManager();
});
