import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import { getFirestore, collection, getDocs, addDoc, doc, updateDoc, deleteDoc, getDoc, setDoc, orderBy, query, where, runTransaction } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { firebaseConfig, BKASH_NUMBER, COD_NUMBER, DELIVERY_FEE } from './config.js';

// ====== INITIALIZE FIREBASE ======
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ====== GLOBAL UTILS & MEMOIZED CACHING ======
const productsMap = new Map();
let cachedProducts = null;
let fetchPromise = null;

const CACHE_KEY = 'store_products_data';
const CACHE_EXPIRY_KEY = 'store_products_expiry';
const CACHE_TTL = 5 * 60 * 1000;

// ====== DYNAMIC BYTE-SIZE SHARDING ENGINE ======
async function rebuildCatalogShards(productsList) {
  const MAX_BYTES = 800000;
  const chunks = [];
  let currentChunk = [];
  let currentByteSize = 0;

  for (const product of productsList) {
    const productString = JSON.stringify(product);
    const productBytes = new Blob([productString]).size;
    if (currentByteSize + productBytes > MAX_BYTES && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentByteSize = 0;
    }
    currentChunk.push(product);
    currentByteSize += productBytes;
  }

  if (currentChunk.length > 0) chunks.push(currentChunk);

  const metaRef = doc(db, 'store_data', 'catalog_meta');
  const metaSnap = await getDoc(metaRef);
  const oldShardCount = metaSnap.exists() ? (metaSnap.data().shardCount || 0) : 0;

  for (let i = 0; i < chunks.length; i++) {
    await setDoc(doc(db, 'master_catalog_shards', `shard_${i}`), { items: chunks[i] });
  }

  if (oldShardCount > chunks.length) {
    for (let i = chunks.length; i < oldShardCount; i++) {
      try { await deleteDoc(doc(db, 'master_catalog_shards', `shard_${i}`)); } 
      catch (e) { console.warn(`Cleanup skipped for shard_${i}`); }
    }
  }

  await setDoc(metaRef, { shardCount: chunks.length });
}

// Background sync function used by Admin tools
async function syncMasterCatalog() {
  try {
    const snapshot = await getDocs(collection(db, 'products'));
    const productsList = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    
    // --- NEW: Generate the Flat Live Inventory Map ---
    const liveInventoryMap = {};
    productsList.forEach(p => { liveInventoryMap[p.id] = p.stock; });
    await setDoc(doc(db, 'store_data', 'live_inventory'), liveInventoryMap);
    // -------------------------------------------------

    await rebuildCatalogShards(productsList);
  } catch (err) {
    console.error("Critical: Failed to compile master catalog matrix:", err);
  }
}

// --- NEW: Advanced Multi-Source Loader ---
async function loadProducts(forceRefresh = false) {
  const now = Date.now();

  if (forceRefresh) {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_EXPIRY_KEY);
    cachedProducts = null;
    fetchPromise = null;
  }
  
  if (cachedProducts) return cachedProducts;
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    let products = [];
    const localCache = localStorage.getItem(CACHE_KEY);
    const cacheExpiry = localStorage.getItem(CACHE_EXPIRY_KEY);

    // 1. Fetch BASE Catalogue (from Cache or Shards)
    if (localCache && cacheExpiry && now < Number(cacheExpiry)) {
      try { products = JSON.parse(localCache); } 
      catch (err) { console.error('Cache parsing failed:', err); }
    }

    if (products.length === 0) {
      try {
        const metaRef = doc(db, 'store_data', 'catalog_meta');
        const metaSnap = await getDoc(metaRef);
        
        if (metaSnap.exists()) {
          const shardCount = metaSnap.data().shardCount || 0;
          const shardPromises = [];
          for (let i = 0; i < shardCount; i++) {
            shardPromises.push(getDoc(doc(db, 'master_catalog_shards', `shard_${i}`)));
          }
          const shardSnaps = await Promise.all(shardPromises);
          shardSnaps.forEach(snap => {
            if (snap.exists()) { products = products.concat(snap.data().items || []); }
          });
        } else {
          await syncMasterCatalog();
          const snapshot = await getDocs(collection(db, 'products'));
          products = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        }
        
        localStorage.setItem(CACHE_KEY, JSON.stringify(products));
        localStorage.setItem(CACHE_EXPIRY_KEY, (now + CACHE_TTL).toString());
      } catch (err) {
        console.error('Error loading products:', err);
        return [];
      }
    }

    // 2. --- NEW: Merge Flat Live Inventory into memory ---
    try {
      const liveSnap = await getDoc(doc(db, 'store_data', 'live_inventory'));
      if (liveSnap.exists()) {
        const liveData = liveSnap.data();
        products = products.map(p => {
          if (liveData[p.id] !== undefined) {
            p.stock = liveData[p.id];
            if (Number(p.stock) <= 0 && p.availability !== 'Pre Order') {
              p.availability = 'Out of Stock';
            }
          }
          return p;
        });
      }
    } catch (e) {
      console.warn("Live inventory check bypassed:", e);
    }
    // ----------------------------------------------------

    cachedProducts = products;
    productsMap.clear();
    products.forEach(p => productsMap.set(p.id, p));
    return products;
  })();

  return fetchPromise;
}

function shuffle(array) {
  return array.slice().sort(() => Math.random() - 0.5);
}

function calculateDeliveryFee(address) {
  const lowerAddr = address.toLowerCase();
  if (lowerAddr.includes("savar")) return 70;
  else if (lowerAddr.includes("dhaka")) return 110;
  return 150;
}

// ====== ULTIMATE SPECIFICATION PARSER ======
function parseSpecsData(specData) {
  if (!specData) return {};
  if (typeof specData === 'object') return specData;
  if (typeof specData === 'string') {
    let str = specData.trim();
    if (str.startsWith('{')) { try { return JSON.parse(str); } catch(e) {} }
    if (!str.includes(':')) { return { "Details": str }; }

    const specsObj = {};

    if (str.includes('\n')) {
      const lines = str.split('\n');
      lines.forEach(line => {
        if (line.includes(':')) {
          const [k, ...v] = line.split(':');
          const key = k.trim().replace(/[^a-zA-Z0-9\- ]/g, ''); 
          let val = v.join(':').trim().replace(/\?$/, '').trim(); 
          if (key && val) {
            const properKey = key.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
            specsObj[properKey] = val;
          }
        }
      });
      return specsObj;
    }

    const knownKeys = [
      "Material", "Legend", "Printing Process", "Key Count", "Profile", "Layout", 
      "Shine-Through", "Switch Type", "Switches", "Brand", "Model", "Connectivity", 
      "Backlight", "Battery Capacity", "Battery", "Interface", "Weight", "Size", 
      "Features", "Type", "Polling Rate", "Lifespan", "Hotswap", "Hot-swappable", 
      "Color", "Mounting Style", "Case Material", "Plate Material", "Stabilizers", 
      "Compatibility", "Dimensions", "Keycaps", "System Support", "Cable Length"
    ];
    knownKeys.sort((a, b) => b.length - a.length);

    const escapedKeys = knownKeys.map(k => k.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
    const keyRegex = new RegExp(`\\b(${escapedKeys})\\s*:`, 'gi');
    let matches = [];
    let match;
    while ((match = keyRegex.exec(str)) !== null) {
      matches.push({ key: match[1].trim(), index: match.index, end: match.index + match[0].length });
    }

    if (matches.length > 0) {
      for (let i = 0; i < matches.length; i++) {
        const currentMatch = matches[i];
        const nextMatch = matches[i + 1];
        const valueStartIndex = currentMatch.end;
        const valueEndIndex = nextMatch ? nextMatch.index : str.length;
        let value = str.substring(valueStartIndex, valueEndIndex).trim().replace(/\?$/, '').trim(); 
        const properKey = currentMatch.key.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        if (value) specsObj[properKey] = value;
      }
      return specsObj;
    }

    const fallbackParts = str.split(':');
    let currentKey = fallbackParts[0].split(' ').pop().trim();
    for (let i = 1; i < fallbackParts.length; i++) {
      let seg = fallbackParts[i].trim();
      if (i === fallbackParts.length - 1) {
        specsObj[currentKey.charAt(0).toUpperCase() + currentKey.slice(1)] = seg;
      } else {
        let words = seg.split(/\s+/);
        let nextKey = words.pop();
        specsObj[currentKey.charAt(0).toUpperCase() + currentKey.slice(1)] = words.join(' ').trim();
        currentKey = nextKey;
      }
    }
    return specsObj;
  }
  return {};
}

// ====== CROSS-PAGE SEARCH NAV ======
document.addEventListener('DOMContentLoaded', () => {
  const globalSearchInput = document.getElementById('global-search-input');
  if (globalSearchInput) {
    globalSearchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && globalSearchInput.value.trim() !== '') {
        window.location.href = `products.html?search=${encodeURIComponent(globalSearchInput.value.trim())}`;
      }
    });
  }
});

// ====== CART SYSTEM ======
function getCart() {
  const cart = localStorage.getItem('cart');
  return cart ? JSON.parse(cart) : [];
}

function saveCart(cart) {
  localStorage.setItem('cart', JSON.stringify(cart));
  updateCartUI();
}

window.addToCart = function(productId, qty = 1) {
  const product = productsMap.get(productId);
  if (!product || product.availability === 'Upcoming') return;
  
  const isPreOrder = product.availability === 'Pre Order';
  const isOOS = Number(product.stock) <= 0 && !isPreOrder;
  if (isOOS) { alert('This product is out of stock!'); return; }

  let cart = getCart();
  const existing = cart.find(item => item.id === productId);
  const finalPrice = Number(product.discount) > 0 ? (Number(product.price) - Number(product.discount)) : Number(product.price);
  
  if (existing) {
    const newQty = existing.qty + qty;
    if (!isPreOrder && newQty > Number(product.stock)) {
      alert(`Limit reached! Only ${product.stock} available in stock.`);
      return;
    }
    existing.qty = newQty;
  } else {
    if (!isPreOrder && qty > Number(product.stock)) {
      alert(`Limit reached! Only ${product.stock} available in stock.`);
      return;
    }
    cart.push({ id: productId, name: product.name, color: product.color || '', price: finalPrice, image: product.images?.[0] || 'logo.png', qty: qty, isPreOrder: isPreOrder });
  }
  saveCart(cart);
}

function removeFromCart(productId) {
  let cart = getCart();
  cart = cart.filter(item => item.id !== productId);
  saveCart(cart);
}

function updateCartQuantity(productId, newQty) {
  if (newQty < 1) { removeFromCart(productId); return; }
  let cart = getCart();
  const item = cart.find(i => i.id === productId);
  if (item) item.qty = newQty;
  saveCart(cart);
}

function updateCartUI() {
  const cart = getCart();
  const countEl = document.getElementById('cart-count');
  if (countEl) countEl.textContent = cart.reduce((sum, i) => sum + i.qty, 0);

  const itemsContainer = document.getElementById('cart-items');
  const totalEl = document.getElementById('cart-total');
  const emptyMsg = document.getElementById('cart-empty');
  
  if (!itemsContainer) return;

  if (cart.length === 0) {
    itemsContainer.innerHTML = '';
    if (totalEl) totalEl.innerHTML = '<strong>Total: ৳0</strong>';
    if (emptyMsg) emptyMsg.classList.remove('hidden');
    return;
  }

  if (emptyMsg) emptyMsg.classList.add('hidden');
  itemsContainer.innerHTML = '';
  let total = 0;

  cart.forEach(item => {
    const itemTotal = item.price * item.qty;
    total += itemTotal;
    const div = document.createElement('div');
    div.className = 'flex items-center gap-4 bg-surface-container-low p-3 rounded-xl border border-white/5';
    div.innerHTML = `
      <img src="${item.image}" alt="${item.name}" class="w-16 h-16 object-cover rounded-lg bg-surface-container-lowest" onerror="this.src='logo.png'">
      <div class="flex-1 min-w-0">
        <h4 class="text-sm font-bold text-on-surface truncate">${item.name}</h4>
        <div class="text-xs text-slate-400">Color: ${item.color || '-'}</div>
        <div class="text-xs font-mono text-primary font-bold mt-1">৳${item.price} × ${item.qty} = ৳${itemTotal}</div>
        <div class="flex items-center gap-3 mt-2">
          <div class="flex items-center bg-surface-container rounded-lg border border-white/5">
            <button class="qty-minus px-2 py-1 hover:text-white text-slate-400 transition-colors">-</button>
            <span class="qty-display text-xs font-bold w-4 text-center">${item.qty}</span>
            <button class="qty-plus px-2 py-1 hover:text-white text-slate-400 transition-colors">+</button>
          </div>
          <button class="remove-btn text-xs text-red-400 hover:text-red-300 underline">Remove</button>
        </div>
      </div>
    `;
    div.querySelector('.qty-minus').addEventListener('click', () => updateCartQuantity(item.id, item.qty - 1));
    
    div.querySelector('.qty-plus').addEventListener('click', () => {
      const product = productsMap.get(item.id);
      if (product && product.availability !== 'Pre Order' && (item.qty + 1) > Number(product.stock)) {
        alert(`Only ${product.stock} units available in stock.`);
        return;
      }
      updateCartQuantity(item.id, item.qty + 1);
    });
    div.querySelector('.remove-btn').addEventListener('click', () => removeFromCart(item.id));
    itemsContainer.appendChild(div);
  });

  if (totalEl) totalEl.innerHTML = `<strong>Total: ৳${total}</strong>`;
}

function createProductCard(p, products) {
  const isUpcoming = p.availability === 'Upcoming';
  const isOOS = !isUpcoming && Number(p.stock) <= 0 && p.availability !== 'Pre Order';
  const isPreOrder = p.availability === 'Pre Order';
  const hasDiscount = Number(p.discount) > 0;
  const price = Number(p.price) || 0;
  const finalPrice = hasDiscount ? (price - Number(p.discount)) : price;
  const images = p.images || [];

  const sameName = products.filter(other => other.name.toLowerCase() === p.name.toLowerCase());
  let slug = p.name.toLowerCase().replace(/\s+/g, '-');
  if (sameName.length > 1 && p.color) {
    slug += '-' + p.color.toLowerCase().replace(/\s+/g, '-');
  }

  const card = document.createElement('div');
  card.className = "group relative bg-surface-container-low rounded-xl overflow-hidden transition-all duration-500 hover:translate-y-[-8px] border border-white/5 hover:border-primary/30 flex flex-col";
  let badgeHTML = '';
  if (p.hotDeal) badgeHTML += `<span class="bg-primary text-on-primary-fixed text-[10px] font-black px-3 py-1 rounded-full uppercase tracking-widest shadow-xl mr-1 mb-1 inline-block">Hot Deal</span>`;
  if (isPreOrder) badgeHTML += `<span class="bg-purple-600 text-white text-[10px] font-black px-3 py-1 rounded-full uppercase tracking-widest shadow-xl mr-1 mb-1 inline-block">Pre Order</span>`;
  if (isOOS) badgeHTML += `<span class="bg-red-900/80 text-red-200 text-[10px] font-black px-3 py-1 rounded-full uppercase tracking-widest shadow-xl mr-1 mb-1 inline-block">Out of Stock</span>`;
  if (isUpcoming) badgeHTML += `<span class="bg-slate-700 text-slate-200 text-[10px] font-black px-3 py-1 rounded-full uppercase tracking-widest shadow-xl mr-1 mb-1 inline-block">Upcoming</span>`;
  
  card.innerHTML = `
    <div class="aspect-[4/5] bg-surface-container-lowest relative overflow-hidden cursor-pointer flex-shrink-0" onclick="window.location.href='product.html?slug=${slug}'">
      <img class="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-all duration-700 scale-105 group-hover:scale-100" src="${images[0] || 'logo.png'}" alt="${p.name}">
      <div class="absolute top-4 left-4 right-4 flex flex-wrap z-10">${badgeHTML}</div>
      ${!isOOS && !isUpcoming ?
      `<button class="absolute bottom-4 right-4 w-12 h-12 bg-surface-bright/80 backdrop-blur-md rounded-full flex items-center justify-center text-primary opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-4 group-hover:translate-y-0 shadow-2xl z-20" data-id="${p.id}" onclick="event.stopPropagation(); window.addToCart('${p.id}'); alert('Added to cart!');">
        <span class="material-symbols-outlined pointer-events-none">add_shopping_cart</span>
      </button>` : ''}
    </div>
    <div class="p-6 cursor-pointer flex-1 flex flex-col justify-between" onclick="window.location.href='product.html?slug=${slug}'">
      <div>
        <div class="flex justify-between items-start mb-2 gap-2">
          <h3 class="text-xl font-bold tracking-tight line-clamp-1">${p.name}</h3>
          <span class="text-primary font-mono font-bold whitespace-nowrap">${isUpcoming ? 'TBA' : '৳' + finalPrice}</span>
        </div>
        <p class="text-sm text-outline mb-4 line-clamp-2">${p.description || 'Premium component.'}</p>
      </div>
      <div class="flex gap-2 mt-auto">
        ${p.color ? `<span class="bg-surface-container-highest text-[10px] text-on-surface-variant font-bold px-3 py-1 rounded-full truncate max-w-[50%]">${p.color}</span>` : ''}
        ${p.category ? `<span class="bg-surface-container-highest text-[10px] text-on-surface-variant font-bold px-3 py-1 rounded-full truncate max-w-[50%]">${p.category}</span>` : ''}
      </div>
    </div>
  `;
  return card;
}

// ====== PAGE ROUTES ======
async function initHomePage() {
  const productsContainer = document.getElementById('interest-products');
  const products = await loadProducts();
  if (products.length === 0) return;

  const heroSection = document.getElementById('hero-section');
  if (heroSection) {
      const randomProduct = products[Math.floor(Math.random() * products.length)];
      const titleParts = randomProduct.name.split(' ');
      const p1 = titleParts.slice(0, 2).join(' ');
      const p2 = titleParts.slice(2).join(' ') || 'EDITION';
      
      if(document.getElementById('hero-tag')) document.getElementById('hero-tag').textContent = `Featured ${randomProduct.category || 'Gear'}`;
      if(document.getElementById('hero-title')) {
        document.getElementById('hero-title').innerHTML = `${p1} <br/><span class="text-transparent bg-clip-text bg-gradient-to-br from-primary to-primary-container">${p2}</span>`;
        document.getElementById('hero-title').classList.remove('shimmer', 'text-transparent');
      }
      if(document.getElementById('hero-desc')) document.getElementById('hero-desc').textContent = randomProduct.description || "Experience premium mechanical artistry.";
      
      const imgEl = document.getElementById('hero-img');
      if(imgEl && randomProduct.images && randomProduct.images[0]) {
        imgEl.src = randomProduct.images[0];
        imgEl.classList.remove('shimmer');
      }
      
      const sameName = products.filter(other => other.name.toLowerCase() === randomProduct.name.toLowerCase());
      let slug = randomProduct.name.toLowerCase().replace(/\s+/g, '-');
      if (sameName.length > 1 && randomProduct.color) slug += '-' + randomProduct.color.toLowerCase().replace(/\s+/g, '-');
      
      if(document.getElementById('hero-link')) document.getElementById('hero-link').href = `product.html?slug=${slug}`;
      heroSection.classList.remove('opacity-0');
  }

  if (productsContainer) {
    productsContainer.innerHTML = '';
    shuffle(products).slice(0, 8).forEach(p => productsContainer.appendChild(createProductCard(p, products)));
  }
}

async function initProductsPage() {
  const container = document.getElementById('products-grid');
  const paginationContainer = document.getElementById('pagination-controls');
  if (!container) return;

  const products = await loadProducts();
  
  const searchInput = document.getElementById('search-input');
  const sortSelect = document.getElementById('sort-select');
  const categoryContainer = document.getElementById('category-filters-container');
  const dynamicSpecContainer = document.getElementById('dynamic-spec-filters');
  const clearFiltersBtn = document.getElementById('clear-filters-btn');

  let currentPage = 1;
  const itemsPerPage = 21;
  let selectedSpecs = {};
  const categories = ['All', ...new Set(products.map(p => p.category).filter(Boolean))];
  
  if (categoryContainer) {
    categoryContainer.innerHTML = categories.map(cat => `
      <label class="flex items-center gap-3 cursor-pointer group py-1.5 px-2 rounded-xl hover:bg-surface-variant/30 transition-colors">
        <input type="radio" name="cat-filter" value="${cat}" ${cat === 'All' ? 'checked' : ''} class="w-3.5 h-3.5 bg-surface-container-lowest border-white/10 text-primary focus:ring-0 focus:ring-offset-0 rounded">
        <span class="text-xs text-outline-variant group-hover:text-on-surface transition-colors">${cat}</span>
      </label>
    `).join('');
  }

  function buildDynamicSpecFiltersUI() {
    if (!dynamicSpecContainer) return;
    const specMap = {};
    products.forEach(p => {
      const parsedSpecs = parseSpecsData(p.specs);
      if (Object.keys(parsedSpecs).length > 0 && !parsedSpecs["Details"]) {
        Object.entries(parsedSpecs).forEach(([key, val]) => {
          if (key && val && key.toLowerCase() !== 'id') {
            const formattedKey = key.trim();
            const formattedVal = val.toString().trim();
            if (!specMap[formattedKey]) specMap[formattedKey] = new Set();
            specMap[formattedKey].add(formattedVal);
          }
        });
      }
    });
    
    dynamicSpecContainer.innerHTML = Object.entries(specMap).map(([specName, uniqueValues]) => {
      if (!selectedSpecs[specName]) selectedSpecs[specName] = [];
      const optionsHTML = Array.from(uniqueValues).map(val => {
        const isChecked = selectedSpecs[specName].includes(val) ? 'checked' : '';
        return `
          <label class="flex items-center gap-3 cursor-pointer group py-1 px-1.5 rounded-lg hover:bg-surface-variant/30 transition-colors">
            <input type="checkbox" data-spec="${specName}" value="${val}" ${isChecked} class="spec-checkbox w-3.5 h-3.5 bg-surface-container-lowest border-white/10 text-primary focus:ring-0 focus:ring-offset-0 rounded-sm">
            <span class="text-xs text-outline-variant group-hover:text-on-surface transition-colors">${val}</span>
          </label>
        `;
      }).join('');
      
      return `
        <div class="space-y-2">
          <label class="text-[10px] font-bold uppercase tracking-widest text-outline block capitalize">${specName}</label>
          <div class="space-y-1 max-h-40 overflow-y-auto pr-1">${optionsHTML}</div>
        </div>
      `;
    }).join('');

    document.querySelectorAll('.spec-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const specName = e.target.getAttribute('data-spec');
        const value = e.target.value;
        if (e.target.checked) {
          if (!selectedSpecs[specName].includes(value)) selectedSpecs[specName].push(value);
        } else {
          selectedSpecs[specName] = selectedSpecs[specName].filter(v => v !== value);
        }
        currentPage = 1;
        renderGrid();
      });
    });
  }

  const params = new URLSearchParams(window.location.search);
  const urlCategory = params.get('category');
  const urlSearch = params.get('search');
  
  if (urlCategory && categoryContainer) {
     const targetRadio = document.querySelector(`input[name="cat-filter"][value="${urlCategory}"]`);
     if (targetRadio) targetRadio.checked = true;
  }
  if (urlSearch && searchInput) searchInput.value = urlSearch;

  function renderGrid() {
    let result = [...products];
    if (searchInput && searchInput.value) {
      const q = searchInput.value.toLowerCase();
      result = result.filter(p => p.name.toLowerCase().includes(q) || (p.description && p.description.toLowerCase().includes(q)));
    }

    const checkedCat = document.querySelector('input[name="cat-filter"]:checked');
    if (checkedCat && checkedCat.value !== 'All') {
      result = result.filter(p => p.category === checkedCat.value);
    }

    Object.entries(selectedSpecs).forEach(([specKey, allowedValues]) => {
      if (allowedValues.length > 0) {
        result = result.filter(p => {
          const parsedSpecs = parseSpecsData(p.specs);
          return parsedSpecs[specKey] && allowedValues.includes(parsedSpecs[specKey].toString().trim());
        });
      }
    });
    
    if (sortSelect) {
      const sortVal = sortSelect.value;
      if (sortVal === 'price-low') {
        result.sort((a, b) => (Number(a.price) - Number(a.discount || 0)) - (Number(b.price) - Number(b.discount || 0)));
      } else if (sortVal === 'price-high') {
        result.sort((a, b) => (Number(b.price) - Number(b.discount || 0)) - (Number(a.price) - Number(a.discount || 0)));
      }
    }

    const totalPages = Math.ceil(result.length / itemsPerPage);
    if (currentPage > totalPages) currentPage = Math.max(1, totalPages);
    const paginatedItems = result.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
    
    container.innerHTML = '';
    if (result.length === 0) {
      container.innerHTML = `<div class="col-span-full text-center py-12 text-outline bg-surface-container-low rounded-xl border border-white/5">No products found matching your criteria.</div>`;
      if (paginationContainer) paginationContainer.classList.add('hidden');
      return;
    }

    paginatedItems.forEach(p => container.appendChild(createProductCard(p, products)));
    renderPaginationControls(totalPages);
  }

  function renderPaginationControls(totalPages) {
    if (!paginationContainer) return;
    if (totalPages <= 1) {
      paginationContainer.classList.add('hidden');
      return;
    }
    
    paginationContainer.classList.remove('hidden');
    paginationContainer.innerHTML = '';

    const prevBtn = document.createElement('button');
    prevBtn.className = `w-10 h-10 flex items-center justify-center rounded-lg transition-colors ${currentPage === 1 ? 'text-outline/30 cursor-not-allowed' : 'text-outline hover:text-primary bg-surface-container-low hover:bg-surface-container border border-white/5'}`;
    prevBtn.innerHTML = `<span class="material-symbols-outlined">chevron_left</span>`;
    prevBtn.disabled = currentPage === 1;
    prevBtn.onclick = () => { currentPage--; renderGrid(); window.scrollTo({top: 0, behavior: 'smooth'}); };
    paginationContainer.appendChild(prevBtn);
    
    for (let i = 1; i <= totalPages; i++) {
      const pageBtn = document.createElement('button');
      pageBtn.className = `w-10 h-10 flex items-center justify-center font-black rounded-lg transition-all ${currentPage === i ? 'bg-primary text-on-primary-fixed shadow-lg shadow-primary/20' : 'text-outline hover:text-primary bg-surface-container-low hover:bg-surface-container border border-white/5'}`;
      pageBtn.textContent = i;
      pageBtn.onclick = () => { currentPage = i; renderGrid(); window.scrollTo({top: 0, behavior: 'smooth'}); };
      paginationContainer.appendChild(pageBtn);
    }

    const nextBtn = document.createElement('button');
    nextBtn.className = `w-10 h-10 flex items-center justify-center rounded-lg transition-colors ${currentPage === totalPages ? 'text-outline/30 cursor-not-allowed' : 'text-outline hover:text-primary bg-surface-container-low hover:bg-surface-container border border-white/5'}`;
    nextBtn.innerHTML = `<span class="material-symbols-outlined">chevron_right</span>`;
    nextBtn.disabled = currentPage === totalPages;
    nextBtn.onclick = () => { currentPage++; renderGrid(); window.scrollTo({top: 0, behavior: 'smooth'}); };
    paginationContainer.appendChild(nextBtn);
  }

  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      if (sortSelect) sortSelect.value = 'latest';
      const rootRadio = document.querySelector('input[name="cat-filter"][value="All"]');
      if (rootRadio) rootRadio.checked = true;
      selectedSpecs = {};
      currentPage = 1;
      buildDynamicSpecFiltersUI();
      renderGrid();
    });
  }

  if (searchInput) searchInput.addEventListener('input', () => { currentPage = 1; renderGrid(); });
  if (sortSelect) sortSelect.addEventListener('change', () => { currentPage = 1; renderGrid(); });
  if (categoryContainer) categoryContainer.addEventListener('change', () => { currentPage = 1; renderGrid(); });

  buildDynamicSpecFiltersUI();
  renderGrid();
}

async function initProductPage() {
  const params = new URLSearchParams(window.location.search);
  const urlSlug = params.get('slug');
  if (!urlSlug || !document.getElementById('product-section')) return;
  
  const products = await loadProducts();
  let product = null;

  for (const p of products) {
    const sameName = products.filter(other => other.name.toLowerCase() === p.name.toLowerCase());
    let slug = p.name.toLowerCase().replace(/\s+/g, '-');
    if (sameName.length > 1 && p.color) slug += '-' + p.color.toLowerCase().replace(/\s+/g, '-');
    if (slug === urlSlug) { product = p; break; }
  }

  if (!product) {
    document.getElementById('product-section').innerHTML = `<div class="col-span-full text-center py-20 text-outline">Product not found in inventory.</div>`;
    return;
  }

  document.title = product.metaTitle || product.name;
  
  const images = product.images || [];
  const mainImg = document.getElementById('main-image');
  
  if (mainImg) {
    mainImg.src = images[0] || 'logo.png';
    mainImg.onclick = () => {
      document.getElementById('viewer-img').src = mainImg.src;
      document.getElementById('image-viewer').classList.remove('hidden');
    };
  }

  const thumbGallery = document.getElementById('thumbnail-gallery');
  if (thumbGallery) {
    thumbGallery.innerHTML = '';
    images.slice(0, 4).forEach(src => {
      const wrapper = document.createElement('div');
      wrapper.className = "aspect-square bg-surface-container-high rounded-lg overflow-hidden border border-outline-variant/20 cursor-pointer";
      wrapper.innerHTML = `<img src="${src}" class="w-full h-full object-cover grayscale hover:grayscale-0 transition-all">`;
      wrapper.onclick = () => { mainImg.src = src; };
      thumbGallery.appendChild(wrapper);
    });
  }

  if (document.getElementById('product-name')) document.getElementById('product-name').textContent = product.name;
  
  const badgesContainer = document.getElementById('product-badges');
  if (badgesContainer) {
    badgesContainer.innerHTML = '';
    if (product.hotDeal) badgesContainer.innerHTML += `<span class="bg-primary-container text-on-primary-container text-[10px] font-bold px-3 py-1 rounded-full tracking-widest uppercase">Hot Deal</span>`;
    if (product.availability === 'Pre Order') badgesContainer.innerHTML += `<span class="bg-purple-600 text-white text-[10px] font-bold px-3 py-1 rounded-full tracking-widest uppercase">Pre Order</span>`;
    badgesContainer.innerHTML += `<span class="bg-surface-container-highest text-primary text-[10px] font-bold px-3 py-1 rounded-full tracking-widest uppercase">${product.availability || 'In Stock'}</span>`;
  }
  
  const isUpcoming = product.availability === 'Upcoming';
  const hasDiscount = Number(product.discount) > 0;
  const price = Number(product.price) || 0;
  const finalPrice = hasDiscount ? (price - Number(product.discount)) : price;
  
  const priceEl = document.getElementById('product-price');
  if (priceEl) priceEl.innerHTML = isUpcoming ? 'TBA' : `${hasDiscount ? `<s class="text-slate-500 text-xl mr-2">৳${price.toFixed(2)}</s> ` : ''}৳${finalPrice.toFixed(2)}`;
  
  const metaDescEl = document.getElementById('product-meta-desc');
  if (metaDescEl) metaDescEl.textContent = product.metaDescription || product.description || 'No brief summary available for this item.';
  
  const orderRow = document.getElementById('order-row');
  if (orderRow) {
    orderRow.innerHTML = '';
    if (isUpcoming) {
      orderRow.innerHTML = `<button class="w-full py-5 bg-surface-variant/40 backdrop-blur-md text-slate-400 font-display font-bold text-lg rounded-xl cursor-not-allowed" disabled>Upcoming - Stay Tuned</button>`;
    } else if (Number(product.stock) <= 0 && product.availability !== 'Pre Order') {
      orderRow.innerHTML = `<button class="w-full py-5 bg-red-900/30 text-red-400 font-display font-bold text-lg rounded-xl border border-red-900/50 cursor-not-allowed" disabled>Out of Stock</button>`;
    } else {
      orderRow.innerHTML = `
        <button id="btn-buy-now" class="w-full py-5 bg-gradient-to-br from-primary to-primary-container text-on-primary-fixed font-display font-bold text-lg rounded-xl flex items-center justify-center gap-3 hover:shadow-[0_0_20px_rgba(236,215,255,0.3)] transition-all active:scale-95 duration-150">
          <span class="material-symbols-outlined">bolt</span> ${product.availability === 'Pre Order' ? 'Pre Order Now' : 'Order Now'}
        </button>
        <button id="btn-add-cart" class="w-full py-5 bg-surface-variant/40 backdrop-blur-md text-primary font-display font-bold text-lg rounded-xl border border-outline-variant/20 hover:bg-surface-variant/60 transition-all active:scale-95 duration-150">
          Add to Cart
        </button>
      `;
      document.getElementById('btn-buy-now').onclick = () => { window.location.href = `checkout.html?id=${product.id}`; };
      document.getElementById('btn-add-cart').onclick = () => { window.addToCart(product.id); alert('Added to cart!'); };
    }
  }

  if (document.getElementById('product-detailed-desc')) {
    document.getElementById('product-detailed-desc').innerHTML = product.detailedDescription || product.description || '<p>No detailed background information available.</p>';
  }

  const specsGrid = document.getElementById('product-specs-grid');
  if (specsGrid) {
    specsGrid.innerHTML = '';
    const parsedSpecs = parseSpecsData(product.specs);
    
    if (Object.keys(parsedSpecs).length > 0 && !parsedSpecs["Details"]) {
      Object.entries(parsedSpecs).forEach(([key, value]) => {
        if (key.toLowerCase() !== 'id' && value.trim() !== '') {
          specsGrid.innerHTML += `
            <div class="flex flex-col sm:flex-row sm:justify-between items-start sm:items-center py-4 border-b border-white/5 last:border-0 gap-2 sm:gap-4">
              <span class="text-slate-400 font-medium whitespace-nowrap">${key}</span>
              <span class="font-display font-medium text-left sm:text-right text-slate-200">${value}</span>
            </div>`;
        }
      });
    } else if (parsedSpecs["Details"]) {
      specsGrid.innerHTML = `<div class="text-slate-300 text-sm leading-relaxed">${parsedSpecs["Details"]}</div>`;
    } else {
      specsGrid.innerHTML = `
        <div class="flex justify-between items-center py-3 border-b border-white/5">
          <span class="text-slate-400 font-medium">Category</span>
          <span class="font-display font-medium text-right text-slate-200">${product.category || 'N/A'}</span>
        </div>
      `;
    }
  }

  try {
    const otherSection = document.getElementById('other-products');
    if (otherSection) {
      otherSection.innerHTML = '';
      const eligible = products.filter(p => p.availability !== 'Upcoming' && p.id !== product.id);
      shuffle(eligible).slice(0, 4).forEach(p => otherSection.appendChild(createProductCard(p, products)));
    }
  } catch(e) { console.error("Could not load other products", e); }
}

// ====== DEDICATED CHECKOUT ENGINE ======
async function initCheckoutPage() {
  const urlParams = new URLSearchParams(window.location.search);
  const singleProductId = urlParams.get('id');
  const products = await loadProducts();

  let checkoutItems = [];
  let hasPreOrder = false;
  
  if (singleProductId) {
    const p = products.find(x => x.id === singleProductId);
    if (!p) {
      alert('Product not found.');
      window.location.href = 'index.html';
      return;
    }
    const unitPrice = Number(p.price) - Number(p.discount || 0);
    checkoutItems.push({
      id: p.id,
      name: p.name,
      color: p.color || '',
      price: unitPrice,
      image: p.images?.[0] || 'logo.png',
      qty: 1, 
      isPreOrder: p.availability === 'Pre Order'
    });
    if (p.availability === 'Pre Order') hasPreOrder = true;
  } else {
    const cart = getCart();
    if (cart.length === 0) {
      alert('Your cart is empty!');
      window.location.href = 'index.html';
      return;
    }
    cart.forEach(item => {
      const p = products.find(pr => pr.id === item.id);
      if (p) {
        item.isPreOrder = p.availability === 'Pre Order';
        if (item.isPreOrder) hasPreOrder = true;
        checkoutItems.push(item);
      }
    });
  }

  const itemsList = document.getElementById('co-items-list');
  let subtotal = 0;
  if (itemsList) {
    itemsList.innerHTML = '';
    checkoutItems.forEach(item => {
      const itemTotal = item.price * item.qty;
      subtotal += itemTotal;
      itemsList.innerHTML += `
        <div class="flex gap-4 items-center bg-surface-container-lowest p-3 rounded-xl border border-white/5">
          <img src="${item.image}" class="w-16 h-16 object-cover rounded-lg bg-surface-variant">
          <div class="flex-grow">
            <h4 class="font-headline text-sm font-bold text-on-surface">${item.name}</h4>
            <p class="text-xs text-outline mb-1">Color: ${item.color || 'Base'} | Qty: ${item.qty}</p>
            <span class="text-primary font-mono text-sm font-bold">৳${itemTotal.toFixed(2)}</span>
          </div>
        </div>
      `;
    });
  }

  const subtotalDisplay = document.getElementById('co-subtotal-display');
  if (subtotalDisplay) subtotalDisplay.textContent = `৳${subtotal.toFixed(2)}`;

  const bkashRadio = document.getElementById('pay-bkash');
  const codRadio = document.getElementById('pay-cod');
  
  if (hasPreOrder && codRadio) {
    codRadio.disabled = true;
    codRadio.parentElement?.classList.add('opacity-30', 'pointer-events-none');
    if (bkashRadio) bkashRadio.checked = true;
  }

  function updateCheckoutTotals() {
    const address = document.getElementById('co-address')?.value || '';
    const deliveryFee = calculateDeliveryFee(address);
    const deliveryDisplay = document.getElementById('co-delivery-display');
    if(deliveryDisplay) deliveryDisplay.textContent = `৳${deliveryFee.toFixed(2)}`;

    const total = subtotal + deliveryFee;
    const totalDisplay = document.getElementById('co-total-display');
    if(totalDisplay) totalDisplay.textContent = `৳${total.toFixed(2)}`;

    const selectedMethod = document.querySelector('input[name="payment_method"]:checked')?.value;
    const payBox = document.getElementById('payment-details-box');
    const merchantLabel = document.getElementById('co-merchant-number');
    const txnContainer = document.getElementById('txn-container');
    const paymentNote = document.getElementById('co-payment-note');
    const splitDisplay = document.getElementById('preorder-split-display');

    if (selectedMethod && payBox) payBox.classList.remove('hidden');
    
    if (hasPreOrder) {
      const advance = Math.round((subtotal * 0.25) / 5) * 5;
      if(splitDisplay) splitDisplay.classList.remove('hidden');
      if(document.getElementById('co-advance-display')) document.getElementById('co-advance-display').textContent = `৳${advance.toFixed(2)}`;
      if(document.getElementById('co-due-display')) document.getElementById('co-due-display').textContent = `৳${(total - advance).toFixed(2)}`;
      
      if(merchantLabel) merchantLabel.textContent = BKASH_NUMBER;
      if(txnContainer) txnContainer.classList.remove('hidden');
      if(paymentNote) paymentNote.textContent = `Please send 25% advance ৳${advance.toFixed(2)} to ${BKASH_NUMBER} via bKash Send Money to confirm pre-order.`;
    } 
    else if (selectedMethod === 'Bkash') {
      if(splitDisplay) splitDisplay.classList.add('hidden');
      if(merchantLabel) merchantLabel.textContent = BKASH_NUMBER;
      if(txnContainer) txnContainer.classList.remove('hidden');
      if(paymentNote) paymentNote.textContent = `Please send total ৳${total.toFixed(2)} to ${BKASH_NUMBER} via bKash Send Money.`;
    } 
    else if (selectedMethod === 'Cash on Delivery') {
      if(splitDisplay) splitDisplay.classList.add('hidden');
      if(merchantLabel) merchantLabel.textContent = COD_NUMBER;
      if(txnContainer) txnContainer.classList.remove('hidden');
      if(paymentNote) paymentNote.textContent = `Please send ONLY the delivery charge ৳${deliveryFee.toFixed(2)} to ${COD_NUMBER} via bKash Send Money to confirm.
Subtotal collected on delivery.`;
    }
  }

  document.getElementById('co-address')?.addEventListener('input', updateCheckoutTotals);
  document.querySelectorAll('input[name="payment_method"]').forEach(r => r.addEventListener('change', updateCheckoutTotals));
  updateCheckoutTotals();

  const btn = document.getElementById('final-checkout-btn');
  if(btn) {
    btn.addEventListener('click', async () => {
      const name = document.getElementById('co-name')?.value.trim();
      const phone = document.getElementById('co-phone')?.value.trim();
      const address = document.getElementById('co-address')?.value.trim();
      const paymentMethod = document.querySelector('input[name="payment_method"]:checked')?.value;
      const txnId = document.getElementById('co-txn')?.value.trim();
      const policyAccepted = document.getElementById('co-policy')?.checked;

      if (!name || !phone || !address || !paymentMethod) {
        alert("Please complete all Operative Details and select a Settlement Protocol.");
        return;
      }
      
      if ((paymentMethod === 'Bkash' || paymentMethod === 'Cash on Delivery') && !txnId) {
        alert("Transaction ID is required to verify your payment/delivery charge.");
        return;
      }
      
      if (!policyAccepted) {
        alert("You must accept the Shipping & Return policies to deploy.");
        return;
      }

      btn.innerHTML = `<span class="material-symbols-outlined animate-spin">sync</span> PROCESSING...`;
      btn.disabled = true;

      const deliveryFee = calculateDeliveryFee(address);
      const total = subtotal + deliveryFee;
      let paid = 0, due = 0;
      
      if (hasPreOrder) {
        paid = Math.round((subtotal * 0.25) / 5) * 5;
        due = total - paid;
      } else if (paymentMethod === 'Bkash') {
        paid = total;
        due = 0;
      } else if (paymentMethod === 'Cash on Delivery') {
        paid = deliveryFee;
        due = subtotal;
      }

      try {
        const orderData = {
          timeISO: new Date().toISOString(),
          items: checkoutItems.map(i => ({
              productId: i.id,
              productName: i.name,
              color: i.color,
              quantity: i.qty,
              unitPrice: i.price,
              wasPreOrder: i.isPreOrder
          })),
          deliveryFee, total, paid, due,
          customerName: name, phone, address,
          paymentMethod,
          paymentNumber: document.getElementById('co-merchant-number')?.textContent || BKASH_NUMBER,
          transactionId: txnId.toUpperCase(),
          status: 'Pending Verification'
        };
        
        let generatedOrderId = '';

        // --- NEW: THE SECURE CHECKOUT TRANSACTION ---
        await runTransaction(db, async (transaction) => {
          const productRefs = checkoutItems.map(item => doc(db, 'products', item.id));
          const productSnaps = await Promise.all(productRefs.map(ref => transaction.get(ref)));

          for (let i = 0; i < checkoutItems.length; i++) {
            const snap = productSnaps[i];
            if (!snap.exists()) throw new Error(`Inventory mismatch: Product ${checkoutItems[i].name} does not exist in backend.`);

            const data = snap.data();
            const currentStock = Number(data.stock);
            const item = checkoutItems[i];

            if (currentStock !== -1 && data.availability !== 'Pre Order' && currentStock < item.qty) {
               throw new Error(`Insufficient stock for ${item.name}. Only ${currentStock} left available.`);
            }
          }

          const liveInventoryRef = doc(db, 'store_data', 'live_inventory');
          const liveUpdates = {};

          // Safely deduct stock for standard items
          for (let i = 0; i < checkoutItems.length; i++) {
            const snap = productSnaps[i];
            const data = snap.data();
            const currentStock = Number(data.stock);
            const item = checkoutItems[i];
            
            if (currentStock !== -1 && data.availability !== 'Pre Order') {
              const newStock = currentStock - item.qty;
              transaction.update(productRefs[i], { stock: newStock }); // Update secure admin file
              liveUpdates[item.id] = newStock;                         // Prep public map update
            }
          }

          const newOrderRef = doc(collection(db, 'orders'));
          transaction.set(newOrderRef, orderData);
          generatedOrderId = newOrderRef.id;

          // Push new stock numbers to the live map instantly
          if (Object.keys(liveUpdates).length > 0) {
            transaction.set(liveInventoryRef, liveUpdates, { merge: true });
          }
        });
        
        // Wipe local storage so their browser fetches the new stock numbers on next page load
        localStorage.removeItem('store_products_data');
        localStorage.removeItem('store_products_expiry');
        // ------------------------------------------

        if (!singleProductId) {
          localStorage.removeItem('cart');
          updateCartUI();
        }
        
        showOrderConfirmation(generatedOrderId);
      } catch (err) {
        console.error(err);
        alert("Transaction Aborted: " + err.message);
        btn.innerHTML = `<span class="material-symbols-outlined">rocket_launch</span> Authorize Deployment`;
        btn.disabled = false;
      }
    });
  }
}

function showOrderConfirmation(orderId) {
  const modal = document.createElement('div');
  modal.className = "fixed inset-0 z-[200] flex items-center justify-center p-6 bg-slate-950/90 backdrop-blur-md opacity-0 transition-opacity duration-500";
  modal.innerHTML = `
    <div class="bg-surface-container-high w-full max-w-sm rounded-2xl overflow-hidden border border-primary/20 shadow-2xl transform scale-95 transition-transform duration-500 text-center flex flex-col items-center p-10">
      <div class="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mb-6">
        <span class="material-symbols-outlined text-5xl text-primary">verified</span>
      </div>
      <h2 class="font-headline text-3xl font-bold tracking-tighter text-on-surface mb-2">Transmission<br>Successful</h2>
      <p class="text-outline text-sm mb-6 leading-relaxed">Dispatch manifest <span class="text-primary font-mono font-bold">#${orderId.slice(-6).toUpperCase()}</span> has been uploaded to the lattice.</p>
      <button onclick="window.location.href='index.html'" class="w-full bg-primary text-white font-headline font-bold py-4 rounded-xl tracking-widest uppercase shadow-lg shadow-purple-500/20 active:scale-[0.98] transition-all">
        Return to Base
      </button>
    </div>
  `;
  document.body.appendChild(modal);
  setTimeout(() => {
    modal.classList.remove('opacity-0');
    modal.querySelector('div')?.classList.remove('scale-95');
  }, 50);
}

// ====== ADMIN SYSTEM ======
const statusExplanations = {
  "Pending Verification": "Order received. Awaiting TrxID/Payment verification by admin.",
  "Processing": "Payment verified. Lab is packing the order.",
  "Dispatched": "Order handed over to the delivery courier.",
  "Delivered": "Customer has received the item.",
  "Cancelled": "Order voided (Invalid payment, fake info, etc.)"
};

const statusColors = {
  "Pending Verification": "bg-yellow-900/30 text-yellow-400 border-yellow-900/50",
  "Processing": "bg-blue-900/30 text-blue-400 border-blue-900/50",
  "Dispatched": "bg-purple-900/30 text-purple-400 border-purple-900/50",
  "Delivered": "bg-green-900/30 text-green-400 border-green-900/50",
  "Cancelled": "bg-red-900/30 text-red-400 border-red-900/50"
};

async function initAdminPanel() {
  const loginSection = document.getElementById('login-section');
  const dashboardSection = document.getElementById('dashboard-section');
  const logoutBtn = document.getElementById('logout-btn');
  
  onAuthStateChanged(auth, user => {
    if (user) {
      if(loginSection) loginSection.classList.add('hidden');
      if(dashboardSection) dashboardSection.classList.remove('hidden');
      if(logoutBtn) logoutBtn.classList.remove('hidden'); 
      if (document.getElementById('inventory-tab')) setupInventoryAdmin();
      if (document.getElementById('orders-tab')) setupOrdersAdmin();
    } else {
      if(loginSection) loginSection.classList.remove('hidden');
      if(dashboardSection) dashboardSection.classList.add('hidden');
      if(logoutBtn) logoutBtn.classList.add('hidden'); 
    }
  });

  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value;
      const pwd = document.getElementById('password').value;
      try { await signInWithEmailAndPassword(auth, email, pwd); } catch (err) { alert(err.message); }
    });
  }

  if(logoutBtn) logoutBtn.addEventListener('click', () => signOut(auth));
}

async function setupInventoryAdmin() {
  const form = document.getElementById('product-form');
  const listContainer = document.getElementById('admin-products-list');
  let editingId = null;
  let products = await loadProducts();

  function switchToAddTab(isResetting = true) {
    document.getElementById('tab-add')?.classList.add('border-primary', 'text-primary');
    document.getElementById('tab-add')?.classList.remove('border-transparent', 'text-slate-400');
    document.getElementById('tab-manage')?.classList.remove('border-primary', 'text-primary');
    document.getElementById('tab-manage')?.classList.add('border-transparent', 'text-slate-400');
    
    document.getElementById('view-add')?.classList.remove('hidden');
    document.getElementById('view-manage')?.classList.add('hidden');
    
    if (isResetting && form) {
      editingId = null;
      form.reset();
      document.getElementById('form-title').textContent = 'Add New Product';
      document.getElementById('submit-btn').innerHTML = '<span class="material-symbols-outlined">add_circle</span> Add Product';
    }
  }

  document.getElementById('tab-add')?.addEventListener('click', () => { switchToAddTab(true); });
  
  document.getElementById('tab-manage')?.addEventListener('click', async () => {
    document.getElementById('tab-manage')?.classList.add('border-primary', 'text-primary');
    document.getElementById('tab-manage')?.classList.remove('border-transparent', 'text-slate-400');
    document.getElementById('tab-add')?.classList.remove('border-primary', 'text-primary');
    document.getElementById('tab-add')?.classList.add('border-transparent', 'text-slate-400');
    document.getElementById('view-manage')?.classList.remove('hidden');
    document.getElementById('view-add')?.classList.add('hidden');
    products = await loadProducts();
    renderAdminProductsList();
  });

  function renderAdminProductsList() {
    if (!listContainer) return;
    listContainer.innerHTML = '';
    
    products.forEach(p => {
      const div = document.createElement('div');
      div.className = 'bg-surface-container-low p-4 rounded-xl border border-white/5 flex flex-col md:flex-row gap-4 items-center justify-between hover:border-primary/30 transition-colors';
      div.innerHTML = `
        <div class="flex items-center gap-4 w-full md:w-auto">
          <img src="${p.images?.[0] || 'logo.png'}" class="w-16 h-16 rounded-lg object-cover bg-surface-variant">
          <div>
            <h4 class="font-bold text-on-surface truncate">${p.name}</h4>
            <div class="text-xs text-outline font-mono">Stock: ${p.stock} | ৳${p.price}</div>
          </div>
        </div>
        <div class="flex gap-2 w-full md:w-auto justify-end">
          <button class="edit-btn px-4 py-2 bg-surface-variant hover:bg-surface-bright text-slate-200 text-xs rounded-lg font-bold uppercase transition-colors">Edit</button>
          <button class="del-btn px-4 py-2 bg-red-900/30 hover:bg-red-900/50 text-red-400 text-xs rounded-lg font-bold uppercase transition-colors">Delete</button>
        </div>
      `;
      
      div.querySelector('.edit-btn').onclick = () => {
        switchToAddTab(false);
        editingId = p.id;
        document.getElementById('p-name').value = p.name || '';
        document.getElementById('p-category').value = p.category || '';
        document.getElementById('p-price').value = p.price || '';
        document.getElementById('p-discount').value = p.discount || '0';
        document.getElementById('p-stock').value = p.stock || '';
        document.getElementById('p-color').value = p.color || '';
        document.getElementById('p-availability').value = p.availability || 'In Stock';
        document.getElementById('p-hot').checked = p.hotDeal || false;
        document.getElementById('p-desc').value = p.description || '';
        document.getElementById('p-meta-desc').value = p.metaDescription || '';
        document.getElementById('p-detailed-desc').value = p.detailedDescription || '';
        document.getElementById('p-images').value = p.images ? p.images.join('\n') : '';

        if (typeof p.specs === 'object') {
          document.getElementById('p-specs').value = Object.entries(p.specs).map(([k,v]) => `${k}: ${v}`).join('\n');
        } else {
          document.getElementById('p-specs').value = p.specs || '';
        }
        document.getElementById('form-title').textContent = 'Edit Product';
        document.getElementById('submit-btn').innerHTML = '<span class="material-symbols-outlined">save</span> Save Changes';
      };
      
      div.querySelector('.del-btn').onclick = async () => {
        if(confirm(`Delete ${p.name}?`)) {
          await deleteDoc(doc(db, 'products', p.id));
          await syncMasterCatalog();
          products = await loadProducts(true);
          renderAdminProductsList();
        }
      };
      listContainer.appendChild(div);
    });
  }

  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const imagesRaw = document.getElementById('p-images').value.split('\n').map(s=>s.trim()).filter(Boolean);
      const data = {
        name: document.getElementById('p-name').value,
        category: document.getElementById('p-category').value,
        price: Number(document.getElementById('p-price').value),
        discount: Number(document.getElementById('p-discount').value),
        stock: Number(document.getElementById('p-stock').value),
        color: document.getElementById('p-color').value,
        availability: document.getElementById('p-availability').value,
        hotDeal: document.getElementById('p-hot').checked,
        description: document.getElementById('p-desc').value,
        metaDescription: document.getElementById('p-meta-desc').value,
        detailedDescription: document.getElementById('p-detailed-desc').value,
        images: imagesRaw,
        specs: document.getElementById('p-specs').value
      };
      
      try {
        if (editingId) { await updateDoc(doc(db, 'products', editingId), data); alert('Updated!'); } 
        else { await addDoc(collection(db, 'products'), data); alert('Added!'); }
        
        await syncMasterCatalog();
        products = await loadProducts(true);
        switchToAddTab(true); 
      } catch(err) { alert(err.message); }
    };
  }
}

async function setupOrdersAdmin() {
  const listContainer = document.getElementById('orders-list');
  if (!listContainer) return;
  
  async function loadAndRenderOrders() {
    listContainer.innerHTML = '<div class="p-8 text-center text-outline"><span class="material-symbols-outlined animate-spin">sync</span></div>';
    try {
      const q = query(collection(db, 'orders'), orderBy('timeISO', 'desc'));
      const snapshot = await getDocs(q);
      
      if (snapshot.empty) {
        listContainer.innerHTML = '<div class="p-8 text-center text-outline">No active manifests found.</div>';
        return;
      }

      listContainer.innerHTML = '';
      snapshot.forEach(documentSnapshot => {
        const o = documentSnapshot.data();
        const oId = documentSnapshot.id;
        const dateString = o.timeISO ? new Date(o.timeISO).toLocaleString() : new Date().toLocaleString();
        
        const badgeClass = statusColors[o.status] || "bg-surface-variant text-slate-300";

        let itemsHtml = '';
        (o.items || []).forEach(i => {
          const qty = i.quantity || i.qty || 1;
          const name = i.productName || i.name || 'Unknown Item';
          const col = i.color ? `(${i.color})` : '';
          itemsHtml += `<div class="text-sm"><span class="text-primary font-bold">x${qty}</span> ${name} ${col}</div>`;
        });

        const div = document.createElement('div');
        div.className = "bg-surface-container p-6 rounded-2xl border border-white/5 space-y-4 shadow-xl";
        div.innerHTML = `
          <div class="flex flex-col md:flex-row justify-between md:items-center gap-4 border-b border-white/5 pb-4">
            <div>
              <div class="font-mono text-xs text-outline mb-1">ID: ${oId} | ${dateString}</div>
              <h3 class="font-bold text-lg">${o.customerName}</h3>
              <div class="text-sm text-outline flex items-center gap-3 mt-1">
                <a href="tel:${o.phone}" class="hover:text-primary transition-colors flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">call</span> ${o.phone}</a>
              </div>
            </div>
            <div class="flex flex-col items-end gap-2">
              <span class="px-4 py-1 rounded-full text-xs font-bold border uppercase tracking-widest ${badgeClass}">${o.status || 'Pending'}</span>
              <select class="status-select bg-surface-container-low border border-white/10 rounded-lg text-xs px-2 py-1 focus:ring-0 focus:border-primary/50 text-slate-300">
                <option value="Pending Verification" ${o.status==='Pending Verification'?'selected':''}>Pending Verification</option>
                <option value="Processing" ${o.status==='Processing'?'selected':''}>Processing</option>
                <option value="Dispatched" ${o.status==='Dispatched'?'selected':''}>Dispatched</option>
                <option value="Delivered" ${o.status==='Delivered'?'selected':''}>Delivered</option>
                <option value="Cancelled" ${o.status==='Cancelled'?'selected':''}>Cancelled</option>
              </select>
            </div>
          </div>
          
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h4 class="text-xs uppercase tracking-widest text-outline mb-2">Delivery Drop</h4>
              <p class="text-sm text-slate-200 leading-relaxed">${o.address}</p>
            </div>
            <div>
              <h4 class="text-xs uppercase tracking-widest text-outline mb-2">Payment Details (${o.paymentMethod?.toUpperCase() || 'N/A'})</h4>
              <p class="text-sm font-mono text-primary bg-primary/10 px-3 py-1.5 rounded-lg border border-primary/20 w-fit">TrxID: ${o.transactionId || o.trxID || 'N/A'}</p>
            </div>
          </div>

          <div class="border-t border-white/5 pt-4">
            <h4 class="text-xs uppercase tracking-widest text-outline mb-3">Manifest Content</h4>
            <div class="space-y-2 mb-4 bg-surface-container-low p-4 rounded-xl border border-white/5">${itemsHtml}</div>
            <div class="flex justify-end gap-6 text-sm">
              <div class="text-outline text-right">Subtotal:<br>Delivery:<br>Paid:<br>Due:<br><strong class="text-on-surface text-lg mt-1 block">Total:</strong></div>
              <div class="font-mono text-right">৳${o.subtotal || (o.total - o.deliveryFee)}<br>৳${o.deliveryFee}<br>৳${o.paid || 0}<br>৳${o.due || 0}<br><strong class="text-primary text-lg mt-1 block">৳${o.total}</strong></div>
            </div>
          </div>
        `;
        
        div.querySelector('.status-select').addEventListener('change', async (e) => {
          const newStatus = e.target.value;
          try {
            await updateDoc(doc(db, 'orders', oId), { status: newStatus });
            loadAndRenderOrders();
          } catch(err) { alert("Failed to update status: " + err.message); }
        });
        
        listContainer.appendChild(div);
      });
    } catch(err) {
      listContainer.innerHTML = `<div class="p-8 text-center text-red-400">Error loading orders: Check if an Index is required by Firebase on 'timeISO'. ${err.message}</div>`;
    }
  }

  loadAndRenderOrders();
}

// ====== GLOBAL INITIALIZATION ROUTER ======
document.addEventListener('DOMContentLoaded', () => {
  loadProducts();

  try {
    updateCartUI();
  } catch (err) {
    console.warn("Cart update bypassed:", err);
  }

  document.getElementById('cart-link')?.addEventListener('click', () => {
    const slider = document.getElementById('cart-slider');
    if (slider) {
      slider.classList.remove('hidden');
      slider.classList.remove('translate-x-full');
    }
  });
  
  document.getElementById('close-cart')?.addEventListener('click', () => {
    document.getElementById('cart-slider')?.classList.add('translate-x-full');
  });
  
  document.getElementById('checkout-cart')?.addEventListener('click', () => {
    const cart = getCart();
    if (cart.length === 0) { alert('Your cart is empty!'); return; }
    window.location.href = 'checkout.html';
  });

  document.getElementById('close-viewer')?.addEventListener('click', () => {
    document.getElementById('image-viewer')?.classList.add('hidden');
  });

  const isHome = !!document.getElementById('interest-products');
  const isProducts = !!document.getElementById('products-grid');
  const isProduct = !!document.getElementById('product-section');
  const isCheckoutPage = window.location.pathname.includes('checkout.html') || !!document.getElementById('co-items-list');
  const isAdminPage = !!document.getElementById('login-form');

  if (isHome) { initHomePage().catch(e => console.error("Home Error", e)); }
  if (isProducts) { initProductsPage().catch(e => console.error("Products Error", e)); }
  if (isProduct) { initProductPage().catch(e => console.error("Product View Error", e)); }
  if (isCheckoutPage) { initCheckoutPage().catch(e => console.error("Checkout Error", e)); }
  if (isAdminPage) { initAdminPanel().catch(e => console.error("Admin Panel Error", e)); }
});
