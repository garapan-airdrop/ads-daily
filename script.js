document.addEventListener('DOMContentLoaded', () => {
    // Game sites data
    const gameSites = [
        { title: "NARKOBET", url: "https://rebrand.ly/narko-bet", telegram: "https://t.me/cs_hokirecehbot" },
        { title: 'PANDAWA88', url: 'https://rebrand.ly/pandawa88official', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'TIRAI77', url: 'https://rebrand.ly/tirai77official', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'TOKOHOKI78', url: 'https://rebrand.ly/tokohoki78', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'MANIASLOT', url: 'https://rebrand.ly/maniaslotofficial', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'GALAXYBET88', url: 'https://rebrand.ly/galaxyplay88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'INDOSLOTS', url: 'https://rebrand.ly/seo-indoslots', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'SLOTSGG', url: 'https://rebrand.ly/slotsgg', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'LIGAPLAY88', url: 'https://rebrand.ly/digital-ligaplay88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'JAVAPLAY88', url: 'https://rebrand.ly/digital-javaplay88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'IDNGG', url: 'https://rebrand.ly/idnggofficial', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'VISABET88', url: 'https://rebrand.ly/visabet88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'SLOTID88', url: 'https://rebrand.ly/-slotid88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: '7WINBET', url: 'https://rebrand.ly/-7winbet', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'ASIANWIN88', url: 'https://rebrand.ly/-asianwin88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'BOLAGG', url: 'https://rebrand.ly/bolagg', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'PERMATABET88', url: 'https://rebrand.ly/permatabet88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'EXABET88', url: 'https://rebrand.ly/-exabet88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'VEGASHOKI88', url: 'https://rebrand.ly/vegashoki88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'ILUCKY88', url: 'https://rebrand.ly/digital-ilucky88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'STASIUNPLAY', url: 'https://rebrand.ly/stasiun-play', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'IHOKIBET', url: 'https://rebrand.ly/-ihokibet', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'IDNCASH', url: 'https://rebrand.ly/-idncash', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'KINGJR99', url: 'https://rebrand.ly/kingjr99', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'PROPLAY88', url: 'https://rebrand.ly/-proplay88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'INDOGG', url: 'https://bit.ly/indogg-official', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'TIKETSLOT', url: 'https://bit.ly/tiket-slot', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'TRADISIBET', url: 'https://bit.ly/tradisibet-official', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'PIONBET', url: 'https://bit.ly/pionbet-official', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'KLIKSLOTS', url: 'https://bit.ly/426Dpbf', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'KERABATSLOT', url: 'https://rebrand.ly/-kerabatslot', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'CASPO777', url: 'https://rebrand.ly/-caspo777', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'AREASLOTS', url: 'https://rebrand.ly/-areaslots', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'LANDSLOT88', url: 'https://rebrand.ly/landslot', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'JAGOSLOTS', url: 'https://rebrand.ly/jagoslots', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'ALPHASLOT88', url: 'https://rebrand.ly/-alphaslot88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'DUNIABET', url: 'https://rebrand.ly/-duniabet', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'DASH88', url: 'https://rebrand.ly/dash88official', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'CEMESLOT', url: 'https://rebrand.ly/cemeslot', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'MEGAHOKI88', url: 'https://rebrand.ly/-megahoki88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'GLADIATOR88', url: 'https://rebrand.ly/-gladiator88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'PLAYSLOTS88', url: 'https://rebrand.ly/-playslots88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'SIMPLEBET8', url: 'https://rebrand.ly/-simplebet8', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'NAGAGG', url: 'https://rebrand.ly/digital-nagagg', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'KLIK99', url: 'https://rebrand.ly/-klik99', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'KLUBSLOT', url: 'https://rebrand.ly/-klubslot', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'ANEKASLOTS', url: 'https://rebrand.ly/-anekaslots', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'KEMONBET', url: 'https://rebrand.ly/-kemonbet', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'IBETWIN ASIA', url: 'https://rebrand.ly/-ibetwin', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'KOINSLOTS', url: 'https://rebrand.ly/-koinslots', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'GASKEUNBET', url: 'https://rebrand.ly/-gaskeunbet', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'POWERNET', url: 'https://rebrand.ly/-powernet', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'ENTERSLOTS', url: 'https://rebrand.ly/enterslots', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'BETHOKI77', url: 'https://rebrand.ly/-bethoki77', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'INDOGAME888', url: 'https://rebrand.ly/-indogame888', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'INDOPRIDE88', url: 'https://rebrand.ly/indopride88', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'INDOSUPER', url: 'https://rebrand.ly/indosuper', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'SANTAGG', url: 'https://rebrand.ly/santagg', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'UNOGG', url: 'https://rebrand.ly/id-unogg', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'QQ88BET', url: 'https://rebrand.ly/qq88-bet', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'COIN303', url: 'https://rebrand.ly/-coin303', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'KOINVEGAS', url: 'https://rebrand.ly/koin-vegas', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'VEGASGG', url: 'https://rebrand.ly/-vegasgg', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'PPHOKI', url: 'https://rebrand.ly/-pphoki', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'DEWATERBANG', url: 'https://rebrand.ly/dewaterbang', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'WINSLOTS8', url: 'https://rebrand.ly/-winslots8', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'NIAGABET', url: 'https://rebrand.ly/-niagabet', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'GOBETASIA', url: 'https://rebrand.ly/gobetasiaofficial', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'MEGALIVE99', url: 'https://rebrand.ly/megalive99official', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'VESPATOGEL', url: 'https://rebrand.ly/-vespatogel', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'TAMARABET', url: 'https://rebrand.ly/tamarabet', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'MENTARIJITU', url: 'https://rebrand.ly/mentarijitu', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'OMEGAJITU', url: 'https://rebrand.ly/omegajitu', telegram: 'https://t.me/cs_hokirecehbot' },
        { title: 'MASTERTOTO', url: 'https://tinyurl.com/mastertotoofficial', telegram: 'https://t.me/cs_hokirecehbot' }
    ];

    // Generate game grid
    const gameGrid = document.querySelector('.game-grid');
    if (gameGrid) {
        gameSites.forEach(site => {
            const gameItem = document.createElement('a');
            gameItem.className = 'game-item';
            gameItem.href = site.url;
            gameItem.target = "_blank";
            gameItem.rel = "noopener noreferrer";
            gameItem.innerHTML = `
                <h3 class="game-title">${site.title}</h3>
                <div class="login-button">
                    <span>DAFTAR SEKARANG</span>
                </div>
            `;
            gameGrid.appendChild(gameItem);
        });
    }

    // Navigation Toggle
    const navToggle = document.querySelector('.nav-toggle');
    const navMenu = document.querySelector('.nav-menu');

    navToggle?.addEventListener('click', () => {
        navMenu.classList.toggle('active');
        const spans = navToggle.querySelectorAll('span');
        spans[0].style.transform = navMenu.classList.contains('active') ? 'rotate(45deg) translate(5px, 5px)' : '';
        spans[1].style.opacity = navMenu.classList.contains('active') ? '0' : '1';
        spans[2].style.transform = navMenu.classList.contains('active') ? 'rotate(-45deg) translate(7px, -7px)' : '';
    });

    // Search Functionality
    const searchInput = document.getElementById("mySearchHkpro");
    const searchBox = searchInput.parentElement;
    const suggestions = document.createElement('div');
    suggestions.className = 'search-suggestions';
    searchBox.appendChild(suggestions);

    searchInput?.addEventListener("input", (e) => {
        const searchTerm = e.target.value.toLowerCase();
        const gameItems = document.querySelectorAll(".game-item");

        if (searchTerm.length > 0) {
            const matchingTitles = Array.from(gameItems)
                .map(item => item.querySelector(".game-title").textContent)
                .filter(title => title.toLowerCase().includes(searchTerm))
                .slice(0, 5);

            suggestions.innerHTML = matchingTitles
                .map(title => `<div class="suggestion-item">${title}</div>`)
                .join('');
            suggestions.style.display = matchingTitles.length ? 'block' : 'none';
        } else {
            suggestions.style.display = 'none';
        }

        gameItems.forEach(item => {
            const title = item.querySelector(".game-title").textContent.toLowerCase();
            item.style.display = title.includes(searchTerm) ? "" : "none";
        });
    });

    suggestions.addEventListener('click', (e) => {
        if (e.target.classList.contains('suggestion-item')) {
            searchInput.value = e.target.textContent;
            suggestions.style.display = 'none';

            const searchEvent = new Event('input');
            searchInput.dispatchEvent(searchEvent);
        }
    });

    // Prevent context menu
    document.addEventListener('contextmenu', e => e.preventDefault());

    // Add intersection observer for animations
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate');
            }
        });
    }, { threshold: 0.1 });

    document.querySelectorAll('.banner-link, .game-item').forEach(el => observer.observe(el));
});