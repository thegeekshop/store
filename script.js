import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import { getFirestore, collection, getDocs, addDoc, doc, updateDoc, deleteDoc, getDoc, orderBy, query, where, runTransaction } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { firebaseConfig, BKASH_NUMBER, COD_NUMBER, DELIVERY_FEE } from './config.js';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Status explanations
const statusExplanations = {
  Pending: 'Order received, waiting for processing.',
  Processing: 'Your order is being prepared.',
  Dispatched: 'Your order has been shipped.',
  Delivered: 'Your order has been delivered.',
  Cancelled: 'Your order has been cancelled.'
};

// Status colors
const statusColors = {
  Pending: '#eab308',
  Processing: '#3b82f6',
  Dispatched: '#eab308',
  Delivered: '#22c55e',
  Cancelled: '#ef4444'
};

// ====== CART SYSTEM ======
function getCart() {
  const cart = localStorage.getItem('cart');
  return cart ? JSON.parse(cart) : [];
}

function saveCart(cart) {
  localStorage.setItem('cart', JSON.stringify(cart));
  updateCartUI();
}

function addToCart(productId, qty = 1) {
  const product = productsMap.get(productId);
  if (!product || product.availability === 'Upcoming') return;

  const isOOS = Number(product.stock) <= 0 && product.availability !== 'Pre Order';
  if (isOOS) {
    alert('This product is out of stock!');
    return;
  }

  let cart = getCart();
  const existing = cart.find(item => item.id === productId);

  const finalPrice = Number(product.discount) > 0 
    ? (Number(product.price) - Number(product.discount)) 
    : Number(product.price);

  if (existing) {
    existing.qty += qty;
  } else {
    cart.push({
      id: productId,
      name: product.name,
      color: product.color || '',
      price: finalPrice,
      image: product.images?.[0] || '',
      qty: qty
    });
  }
  saveCart(cart);
}

function removeFromCart(productId) {
  let cart = getCart();
  cart = cart.filter(item => item.id !== productId);
  saveCart(cart);
}

function updateCartQuantity(productId, newQty) {
  if (newQty < 1) {
    removeFromCart(productId);
    return;
  }
  let cart = getCart();
  const item = cart.find(i => i.id === productId);
  if (item) item.qty = newQty;
  saveCart(cart);
}

function updateCartUI() {
  const cart = getCart();
  const countEl = document.getElementById('cart-count');
  if (countEl) {
    countEl.textContent = cart.reduce((sum, i) => sum + i.qty, 0);
  }

  const itemsContainer = document.getElementById('cart-items');
  const totalEl = document.getElementById('cart-total');
  const emptyMsg = document.getElementById('cart-empty');
  if (!itemsContainer) return;

  if (cart.length === 0) {
    itemsContainer.innerHTML = '';
    if (totalEl) totalEl.innerHTML = '<strong>Total: ৳0</strong>';
    if (emptyMsg) emptyMsg.style.display = 'block';
    return;
  }

  if (emptyMsg) emptyMsg.style.display = 'none';
  itemsContainer.innerHTML = '';
  let total = 0;

  cart.forEach(item => {
    const itemTotal = item.price * item.qty;
    total += itemTotal;

    const div = document.createElement('div');
    div.className = 'cart-item';

    div.innerHTML = `
      <img src="${item.image}" alt="${item.name}" onerror="this.style.display='none'">
      <div class="cart-item-info">
        <h4>${item.name}</h4>
        <div class="muted">Color: ${item.color || '-'}</div>
        <div>৳${item.price} × ${item.qty} = ৳${itemTotal}</div>
        <div class="cart-item-controls">
          <button class="qty-minus" title="Decrease">-</button>
          <span class="qty-display">${item.qty}</span>
          <button class="qty-plus" title="Increase">+</button>
          <button class="remove-btn" title="Remove item">🗑️</button>
        </div>
      </div>
    `;

    // Attach event listeners properly (this is the key fix!)
    const minusBtn = div.querySelector('.qty-minus');
    const plusBtn = div.querySelector('.qty-plus');
    const removeBtn = div.querySelector('.remove-btn');
    const qtyDisplay = div.querySelector('.qty-display');

    minusBtn.addEventListener('click', () => {
      updateCartQuantity(item.id, item.qty - 1);
      qtyDisplay.textContent = Math.max(1, item.qty - 1); // immediate feedback
    });

    plusBtn.addEventListener('click', () => {
      updateCartQuantity(item.id, item.qty + 1);
      qtyDisplay.textContent = item.qty + 1; // immediate feedback
    });

    removeBtn.addEventListener('click', () => {
      removeFromCart(item.id);
    });

    itemsContainer.appendChild(div);
  });

  if (totalEl) totalEl.innerHTML = `<strong>Total: ৳${total}</strong>`;
}
// Global products map for cart
const productsMap = new Map();

// Categories for home
const categories = [
  { name: 'Keycaps', bg: 'k.png' },
  { name: 'Switches', bg: 's.png' },
  { name: 'Keyboard and Mouse', bg: 'k&b.png' },
  { name: 'Accessories and Collectables', bg: 'c&a.png' }
];

// ====== UTIL ======
async function loadProducts() {
  try {
    const snapshot = await getDocs(collection(db, 'products'));
    const products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    productsMap.clear();
    products.forEach(p => productsMap.set(p.id, p));
    return products;
  } catch (err) {
    console.error('Error loading products:', err);
    return [];
  }
}

async function loadOrders() {
  try {
    const q = query(collection(db, 'orders'), orderBy('timeISO', 'desc'));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (err) {
    console.error('Error loading orders:', err);
    return [];
  }
}

function shuffle(array) {
  return array.slice().sort(() => Math.random() - 0.5);
}

// ====== SHIMMER PLACEHOLDERS ======
function createShimmerCard() {
  const card = document.createElement('div');
  card.className = 'card product-card shimmer-placeholder';
  card.innerHTML = `
    <div class="shimmer-image"></div>
    <div class="shimmer-badges">
      <div class="shimmer-badge"></div>
      <div class="shimmer-badge"></div>
    </div>
    <div class="shimmer-title"></div>
    <div class="shimmer-muted"></div>
    <div class="shimmer-price"></div>
    <div class="shimmer-button"></div>
  `;
  return card;
}

function createMainImageShimmer() {
  const img = document.createElement('div');
  img.className = 'shimmer-image-placeholder';
  return img;
}

function createThumbnailShimmer() {
  const thumb = document.createElement('div');
  thumb.className = 'thumbnail shimmer-thumbnail';
  return thumb;
}

function createInfoLineShimmer() {
  const line = document.createElement('div');
  line.className = 'shimmer-line';
  return line;
}

// ====== PRODUCT CARD ======
function createProductCard(p, products) {
  const isUpcoming = p.availability === 'Upcoming';
  const isOOS = !isUpcoming && Number(p.stock) <= 0 && p.availability !== 'Pre Order';
  const isPreOrder = p.availability === 'Pre Order';
  const hasDiscount = Number(p.discount) > 0;
  const price = Number(p.price) || 0;
  const finalPrice = hasDiscount ? (price - Number(p.discount)) : price;
  const images = p.images || [];

  const isInStock = Number(p.stock) > 0 && p.availability === 'Ready';

  const sameName = products.filter(other => other.name.toLowerCase() === p.name.toLowerCase());
  let slug = p.name.toLowerCase().replace(/\s+/g, '-');
  if (sameName.length > 1 && p.color) {
    slug += '-' + p.color.toLowerCase().replace(/\s+/g, '-');
  }

  const card = document.createElement('div');
  card.className = 'card product-card';
  card.innerHTML = `
    <img src="${images[0] || ''}" alt="${p.name}" onerror="this.src=''; this.alt='Image not available';">
    <div class="badges">
      ${p.hotDeal ? `<span class="badge hot">HOT DEAL</span>` : ''}
      ${isInStock ? `<span class="badge new">IN STOCK</span>` : ''}
      ${isOOS ? `<span class="badge oos">OUT OF STOCK</span>` : ''}
      ${isUpcoming ? `<span class="badge upcoming">UPCOMING</span>` : ''}
      ${isPreOrder ? `<span class="badge preorder">PRE ORDER</span>` : ''}
    </div>
    <h3>${p.name}</h3>
    <div class="muted">Color: ${p.color || '-'}</div>
    <div class="price">
      ${isUpcoming ? `TBA` : `${hasDiscount ? `<s>৳${price.toFixed(2)}</s> ` : ``}৳${finalPrice.toFixed(2)}`}
    </div>
    <button class="view-details-btn">View Details</button>
  `;
  card.querySelector('.view-details-btn').addEventListener('click', () => {
    window.location.href = `product.html?slug=${slug}`;
  });
  return card;
}

function createCategoryCard(c) {
  const card = document.createElement('div');
  card.className = 'card category-card';
  card.style.backgroundImage = `url(${c.bg})`;
  card.innerHTML = `<h3>${c.name}</h3>`;
  card.addEventListener('click', () => {
    window.location.href = `products.html?category=${encodeURIComponent(c.name)}`;
  });
  return card;
}

// ====== IMAGE VIEWER ======
function setupImageViewer() {
  const viewer = document.getElementById('image-viewer');
  const viewerImg = document.getElementById('viewer-img');
  const closeViewer = document.getElementById('close-viewer');

  if (!viewer || !viewerImg || !closeViewer) return;

  document.querySelectorAll('.product-card img, .thumbnail, #main-image').forEach(img => {
    img.style.cursor = 'pointer';
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      viewerImg.src = img.src;
      viewerImg.alt = img.alt;
      viewer.classList.add('show');
    });
  });

  viewer.addEventListener('click', (e) => {
    if (e.target === viewer) {
      viewer.classList.remove('show');
      viewer.classList.remove('zoomed');
    }
  });

  closeViewer.addEventListener('click', () => {
    viewer.classList.remove('show');
    viewer.classList.remove('zoomed');
  });

  viewerImg.addEventListener('dblclick', () => {
    viewer.classList.toggle('zoomed');
  });
}

// ====== DELIVERY CHARGE LOGIC ======
function calculateDeliveryFee(address) {
  const lowerAddr = address.toLowerCase();
  if (lowerAddr.includes("savar")) return 70;
  else if (lowerAddr.includes("dhaka")) return 110;
  return 150;
}

function updateDeliveryCharge() {
  const address = document.getElementById('co-address').value.trim();
  const deliveryFee = calculateDeliveryFee(address);
  document.getElementById('co-delivery').value = `Delivery Charge = ${deliveryFee}`;
  document.getElementById('co-delivery').dataset.fee = deliveryFee;
  updateTotalInModal();
}

// ====== CHECKOUT MODAL FLOW (SINGLE PRODUCT) ======
async function openCheckoutModal(productId, isPreOrder = false) {
  const products = await loadProducts();
  const p = products.find(x => x.id === productId);
  if (!p) return;

  const price = p.price === 'TBA' ? 0 : Number(p.price) || 0;
  const discount = Number(p.discount) || 0;
  const unit = price - discount;

  document.getElementById('co-product-id').value = p.id;
  document.getElementById('co-product-name').value = p.name;
  document.getElementById('co-color').value = p.color || '';
  document.getElementById('co-price').value = unit.toFixed(2);
  document.getElementById('co-unit-price-raw').value = unit.toString();
  document.getElementById('co-available-stock').value = String(p.stock);
  document.getElementById('co-qty').value = 1;
  document.getElementById('co-qty').max = p.stock;
  document.getElementById('co-payment').value = isPreOrder ? 'Bkash' : '';
  document.getElementById('co-payment').disabled = isPreOrder;
  document.getElementById('co-payment-number').value = '';
  document.getElementById('co-txn').value = '';
  document.getElementById('co-name').value = '';
  document.getElementById('co-phone').value = '';
  document.getElementById('co-address').value = '';
  document.getElementById('co-note').textContent = '';
  document.getElementById('co-policy').checked = false;
  document.getElementById('co-pay-now').style.display = 'none';
  document.getElementById('co-due-amount').style.display = 'none';

  const deliveryFee = calculateDeliveryFee('');
  document.getElementById('co-delivery').value = `Delivery Charge = ${deliveryFee}`;
  document.getElementById('co-delivery').dataset.fee = deliveryFee;

  if (isPreOrder) {
    const preOrderPrice = Math.round((unit * 0.25) / 5) * 5;
    document.getElementById('co-pay-now').value = preOrderPrice.toFixed(2);
    document.getElementById('co-due-amount').value = (unit - preOrderPrice + deliveryFee).toFixed(2);
    document.getElementById('co-payment-number').value = BKASH_NUMBER;
    document.getElementById('co-note').textContent = `Send ৳${preOrderPrice} to ${BKASH_NUMBER} and enter transaction ID`;
    document.getElementById('co-pay-now').style.display = 'block';
    document.getElementById('co-due-amount').style.display = 'block';
  } else {
    document.getElementById('co-payment-number').value = '';
  }

  document.getElementById('co-total').value = 'Calculating...';
  document.getElementById('checkout-modal').classList.add('show');
  updateTotalInModal();
}

function closeCheckoutModal() {
  document.getElementById('checkout-modal').classList.remove('show');
}

function handlePaymentChange(e) {
  const method = e.target.value;
  const payNowEl = document.getElementById('co-pay-now');
  const dueEl = document.getElementById('co-due-amount');
  const paymentNumberEl = document.getElementById('co-payment-number');
  const txnEl = document.getElementById('co-txn');
  const noteEl = document.getElementById('co-note');

  if (method === 'Bkash') {
     const upfront = Math.round((subtotal * 0.25) / 5) * 5;
    paymentNumberEl.value = BKASH_NUMBER;
    noteEl.textContent = `Send ৳${upfront} to ${BKASH_NUMBER} and enter transaction ID.`;
    txnEl.required = true;
    payNowEl.style.display = 'block';
    dueEl.style.display = 'block';
  } else if (method === 'Cash on Delivery') {
    paymentNumberEl.value = COD_NUMBER;
    noteEl.textContent = `Pay delivery charge ৳${deliveryFee}. Remaining on delivery.`;
    txnEl.required = false;
    txnEl.value = '';
    payNowEl.style.display = 'block';
    dueEl.style.display = 'block';
  } else {
    paymentNumberEl.value = '';
    noteEl.textContent = '';
    txnEl.required = false;
    txnEl.value = '';
    payNowEl.style.display = 'none';
    dueEl.style.display = 'none';
  }
  updateTotalInModal();
}

function updateTotalInModal() {
  const qty = Number(document.getElementById('co-qty').value) || 1;
  const unit = Number(document.getElementById('co-unit-price-raw').value) || 0;
  const delivery = Number(document.getElementById('co-delivery').dataset.fee) || DELIVERY_FEE;
  const subtotal = qty * unit;
  const total = subtotal + delivery;
  document.getElementById('co-total').value = total.toFixed(2);

  const paymentMethod = document.getElementById('co-payment').value;
  const isPreOrderMode = paymentMethod === 'Bkash' && document.getElementById('co-payment').disabled;
  const payNowEl = document.getElementById('co-pay-now');
  const dueEl = document.getElementById('co-due-amount');

  if (isPreOrderMode) {
    const upfront = Math.round((subtotal * 0.25) / 5) * 5;
    payNowEl.value = upfront.toFixed(2);
    dueEl.value = (subtotal + delivery - upfront).toFixed(2);
  } else if (paymentMethod) {
    const payNow = paymentMethod === 'Bkash' ? total : delivery;
    const dueAmount = paymentMethod === 'Bkash' ? 0 : subtotal;
    payNowEl.value = payNow.toFixed(2);
    dueEl.value = dueAmount.toFixed(2);
  } else {
    payNowEl.style.display = 'none';
    dueEl.style.display = 'none';
  }
}

async function submitCheckoutOrder(e) {
  e.preventDefault();
  const btn = document.getElementById('place-order-btn');
  btn.disabled = true;

  if (!document.getElementById('co-policy').checked) {
    alert('Please agree to the order policy.');
    btn.disabled = false;
    return;
  }

  const productId = document.getElementById('co-product-id').value;
  const qty = Number(document.getElementById('co-qty').value);
  const available = Number(document.getElementById('co-available-stock').value);
  if (!productId) { alert('Product ID is missing.'); btn.disabled = false; return; }
  if (qty <= 0) { alert('Quantity must be at least 1.'); btn.disabled = false; return; }
  if (qty > available && available !== -1) { alert(`Quantity exceeds available stock of ${available}.`); btn.disabled = false; return; }

  const unit = Number(document.getElementById('co-unit-price-raw').value);
  if (isNaN(unit)) { alert('Invalid unit price.'); btn.disabled = false; return; }

  const delivery = Number(document.getElementById('co-delivery').dataset.fee);
  if (isNaN(delivery)) { alert('Invalid delivery fee.'); btn.disabled = false; return; }

  const total = (qty * unit) + delivery;

  const currentProduct = products.find(p => p.id === productId);  // products is already loaded earlier

const orderData = {
  timeISO: new Date().toISOString(),
  productId,
  productName: document.getElementById('co-product-name').value,
  color: document.getElementById('co-color').value,
  unitPrice: unit,
  quantity: qty,
  deliveryFee: delivery,
  total,
  paid: Number(document.getElementById('co-pay-now').value) || 0,
  due: Number(document.getElementById('co-due-amount').value) || 0,
  customerName: document.getElementById('co-name').value.trim(),
  phone: document.getElementById('co-phone').value.trim(),
  address: document.getElementById('co-address').value.trim(),
  paymentMethod: document.getElementById('co-payment').value,
  paymentNumber: document.getElementById('co-payment-number').value.trim(),
  transactionId: document.getElementById('co-txn').value.trim().toUpperCase(),
  status: 'Pending',
  wasPreOrder: currentProduct?.availability === 'Pre Order' 
};

  if (!orderData.customerName || !orderData.phone || !orderData.address || !orderData.paymentMethod) {
    alert('Please fill all required fields.');
    btn.disabled = false;
    return;
  }
  if (orderData.paymentMethod === 'Bkash' && (!orderData.paymentNumber || !orderData.transactionId)) {
    alert('Please provide payment number and transaction ID for Bkash.');
    btn.disabled = false;
    return;
  }

  try {
    await runTransaction(db, async (transaction) => {
      const productRef = doc(db, 'products', productId);
      const productSnap = await transaction.get(productRef);
      if (!productSnap.exists()) throw new Error('Product not found.');

      const currentStock = Number(productSnap.data().stock);
      if (currentStock !== -1 && currentStock < qty && productSnap.data().availability !== 'Pre Order') {
        throw new Error(`Insufficient stock. Only ${currentStock} available.`);
      }
      if (currentStock !== -1 && productSnap.data().availability !== 'Pre Order') {
        transaction.update(productRef, { stock: currentStock - qty });
      }
      await addDoc(collection(db, 'orders'), orderData);
    });
    alert('Order placed successfully!');
    closeCheckoutModal();
  } catch (err) {
    console.error('Error placing order:', err);
    alert('Error placing order: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ====== PAGE INIT ======
async function initHomePage() {
  const interestSection = document.getElementById('interest-products');
  const categoriesSection = document.getElementById('categories');
  if (!interestSection || !categoriesSection) return;

  categories.forEach(c => categoriesSection.appendChild(createCategoryCard(c)));

  for (let i = 0; i < 4; i++) interestSection.appendChild(createShimmerCard());

  const products = await loadProducts();
  interestSection.innerHTML = '';
  const eligible = products.filter(p => p.availability !== 'Upcoming');
  const random4 = shuffle(eligible).slice(0, 4);
  random4.forEach(p => interestSection.appendChild(createProductCard(p, products)));

  setupImageViewer();
}

async function initProductsPage() {
  const title = document.getElementById('products-title');
  const list = document.getElementById('product-list');
  if (!list) return;

  const urlParams = new URLSearchParams(window.location.search);
  const category = urlParams.get('category');
  if (category) title.innerText = category;
  else title.innerText = 'All Products';

  for (let i = 0; i < 8; i++) list.appendChild(createShimmerCard());

  const products = await loadProducts();
  list.innerHTML = '';
  const filtered = category ? products.filter(p => p.category === category) : products;
  filtered.forEach(p => list.appendChild(createProductCard(p, products)));

  setupImageViewer();
}

async function initProductPage() {
  const urlParams = new URLSearchParams(window.location.search);
  const urlSlug = urlParams.get('slug');
  if (!urlSlug) {
    alert('Product not found');
    return;
  }

  // === SHIMMER FOR MAIN PRODUCT ===
  const mainImg = document.getElementById('main-image');
  const thumbnailGallery = document.getElementById('thumbnail-gallery');
  const nameEl = document.getElementById('product-name');
  const colorEl = document.getElementById('product-color');
  const priceEl = document.getElementById('product-price');
  const badgesEl = document.getElementById('product-badges');
  const specEl = document.getElementById('product-spec');
  const descEl = document.getElementById('product-detailed-desc');
  const orderRow = document.getElementById('order-row');

  mainImg.parentNode.replaceChild(createMainImageShimmer(), mainImg);
  nameEl.innerHTML = '';
  nameEl.appendChild(createInfoLineShimmer());
  nameEl.appendChild(createInfoLineShimmer());
  colorEl.innerHTML = '';
  colorEl.appendChild(createInfoLineShimmer());
  priceEl.innerHTML = '';
  priceEl.appendChild(createInfoLineShimmer());
  badgesEl.innerHTML = '';
  for (let i = 0; i < 2; i++) {
    const badge = document.createElement('div');
    badge.className = 'shimmer-badge';
    badgesEl.appendChild(badge);
  }
  specEl.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const line = createInfoLineShimmer();
    line.style.width = `${70 + Math.random() * 20}%`;
    specEl.appendChild(line);
  }
  descEl.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const line = createInfoLineShimmer();
    line.style.width = `${70 + Math.random() * 20}%`;
    descEl.appendChild(line);
  }
  orderRow.innerHTML = '';
  const btnShimmer = document.createElement('div');
  btnShimmer.className = 'shimmer-button';
  orderRow.appendChild(btnShimmer);
  for (let i = 0; i < 3; i++) {
    thumbnailGallery.appendChild(createThumbnailShimmer());
  }
  const otherSection = document.getElementById('other-products');
  for (let i = 0; i < 4; i++) {
    otherSection.appendChild(createShimmerCard());
  }

  // === LOAD DATA ===
  const products = await loadProducts();
  let product = null;
  for (const p of products) {
    const sameName = products.filter(other => other.name.toLowerCase() === p.name.toLowerCase());
    let slug = p.name.toLowerCase().replace(/\s+/g, '-');
    if (sameName.length > 1 && p.color) {
      slug += '-' + p.color.toLowerCase().replace(/\s+/g, '-');
    }
    if (slug === urlSlug) {
      product = p;
      break;
    }
  }
  if (!product) {
    alert('Product not found');
    return;
  }

  // === REPLACE MAIN PRODUCT SHIMMER WITH REAL DATA ===
  document.title = product.metaTitle || product.name;
  document.querySelector('#meta-description').setAttribute('content', product.metaDescription || '');
  const sameName = products.filter(p => p.name.toLowerCase() === product.name.toLowerCase());
  let slug = product.name.toLowerCase().replace(/\s+/g, '-');
  if (sameName.length > 1 && product.color) {
    slug += '-' + product.color.toLowerCase().replace(/\s+/g, '-');
  }
  document.getElementById('canonical-link').href = `/product/${slug}`;

  const images = product.images || [];
  const realMainImg = document.createElement('img');
  realMainImg.id = 'main-image';
  realMainImg.src = images[0] || '';
  realMainImg.alt = product.name;
  document.querySelector('.shimmer-image-placeholder').parentNode.replaceChild(realMainImg, document.querySelector('.shimmer-image-placeholder'));

  nameEl.innerHTML = product.name;
  colorEl.innerText = `Color: ${product.color || '-'}`;

  const isUpcoming = product.availability === 'Upcoming';
  const hasDiscount = Number(product.discount) > 0;
  const price = Number(product.price) || 0;
  const finalPrice = hasDiscount ? (price - Number(product.discount)) : price;
  const isInStock = Number(product.stock) > 0 && product.availability === 'Ready';

  priceEl.innerHTML = isUpcoming ? 'TBA' : `${hasDiscount ? `<s>৳${price.toFixed(2)}</s> ` : ''}৳${finalPrice.toFixed(2)}`;

  badgesEl.innerHTML = `
    ${product.hotDeal ? `<span class="badge hot">HOT DEAL</span>` : ''}
    ${isInStock ? `<span class="badge new">IN STOCK</span>` : ''}
    ${!isUpcoming && Number(product.stock) <= 0 && product.availability !== 'Pre Order' ? `<span class="badge oos">OUT OF STOCK</span>` : ''}
    ${isUpcoming ? `<span class="badge upcoming">UPCOMING</span>` : ''}
    ${product.availability === 'Pre Order' ? `<span class="badge preorder">PRE ORDER</span>` : ''}
  `;

  specEl.innerText = product.description || '';
  descEl.innerHTML = product.detailedDescription ? product.detailedDescription.replace(/\n/g, '') : '';

  const button = document.createElement('button');
  if (isUpcoming) {
    button.textContent = 'Upcoming - Stay Tuned';
    button.disabled = true;
  } else if (product.availability === 'Pre Order') {
    button.className = 'preorder-btn';
    button.textContent = 'Pre Order';
    button.onclick = () => openCheckoutModal(product.id, true);
  } else if (Number(product.stock) > 0) {
    button.textContent = 'Order Now';
    button.onclick = () => openCheckoutModal(product.id);
  } else {
    button.textContent = 'Out of Stock';
    button.disabled = true;
  }
  orderRow.innerHTML = '';
  orderRow.appendChild(button);

  // Add to Cart Button
const addToCartBtn = document.createElement('button');
  addToCartBtn.innerHTML = '🛒';
  addToCartBtn.title = 'Add to Cart';
  addToCartBtn.style.marginTop = '';
  addToCartBtn.style.width = '100%';
  addToCartBtn.style.padding = '14px';
  addToCartBtn.style.fontSize = '24px';
  addToCartBtn.style.backgroundColor = '#10b981';
  addToCartBtn.style.color = 'white';
  addToCartBtn.style.border = 'none';
  addToCartBtn.style.borderRadius = '12px';
  addToCartBtn.style.cursor = 'pointer';
  addToCartBtn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';

  const isOOS = !isUpcoming && Number(product.stock) <= 0 && product.availability !== 'Pre Order';

  if (isUpcoming || isOOS) {
    addToCartBtn.innerHTML = isUpcoming ? '⏳' : '❌';
    addToCartBtn.title = isUpcoming ? 'Upcoming' : 'Out of Stock';
    addToCartBtn.disabled = true;
    addToCartBtn.style.backgroundColor = '#6b7280';
    addToCartBtn.style.cursor = 'not-allowed';
  } else {
    addToCartBtn.onclick = () => {
      const qtyInput = document.getElementById('co-qty');
      const qty = qtyInput ? Number(qtyInput.value) || 1 : 1;
      addToCart(product.id, qty);
      alert('Added to cart!');
    };
  }

  orderRow.appendChild(addToCartBtn);
  thumbnailGallery.innerHTML = '';
  if (images.length > 1) {
    images.slice(1).forEach(src => {
      const thumb = document.createElement('img');
      thumb.src = src;
      thumb.alt = product.name;
      thumb.className = 'thumbnail';
      thumb.onclick = () => { realMainImg.src = src; };
      thumbnailGallery.appendChild(thumb);
    });
  }

  otherSection.innerHTML = '';
  const eligible = products.filter(p => p.availability !== 'Upcoming' && p.id !== product.id);
  const random4 = shuffle(eligible).slice(0, 4);
  random4.forEach(p => otherSection.appendChild(createProductCard(p, products)));

  document.getElementById('close-modal-btn').onclick = closeCheckoutModal;
  const form = document.getElementById('checkout-form');
  form.addEventListener('submit', submitCheckoutOrder);
  document.getElementById('co-payment').addEventListener('change', handlePaymentChange);
  document.getElementById('co-qty').addEventListener('input', updateTotalInModal);
  document.getElementById('co-address').addEventListener('input', updateDeliveryCharge);
  setupImageViewer();

  realMainImg.addEventListener('click', () => {
    document.getElementById('viewer-img').src = realMainImg.src;
    document.getElementById('image-viewer').classList.add('show');
  });
}

// ====== ADMIN: ADD PRODUCT ======
async function addProduct(e) {
  e.preventDefault();
  const data = {
    name: document.getElementById('add-name').value.trim(),
    price: document.getElementById('add-price').value.trim() === 'TBA' ? 'TBA' : Number(document.getElementById('add-price').value) || 0,
    discount: Number(document.getElementById('add-discount').value) || 0,
    images: document.getElementById('add-images').value.split(',').map(u => u.trim()).filter(u => u),
    category: document.getElementById('add-category').value,
    color: document.getElementById('add-color').value.trim(),
    stock: Number(document.getElementById('add-stock').value) || 0,
    availability: document.getElementById('add-availability').value,
    hotDeal: !!document.getElementById('add-hotdeal')?.checked,
    description: document.getElementById('add-desc').value.trim(),
    detailedDescription: document.getElementById('add-detailed-desc').value.trim(),
    metaTitle: document.getElementById('add-meta-title').value.trim(),
    metaDescription: document.getElementById('add-meta-desc').value.trim()
  };
  try {
    await addDoc(collection(db, 'products'), data);
    e.target.reset();
    renderDataTable();
  } catch (err) {
    console.error('Add product error:', err);
    alert('Error adding product: ' + err.message);
  }
}

// ====== ADMIN: PRODUCTS TABLE ======
async function renderDataTable() {
  const tbody = document.getElementById('products-body');
  if (!tbody) return;
  const products = await loadProducts();
  tbody.innerHTML = '';
  const cols = [
    { key: 'name' },
    { key: 'price' },
    { key: 'category' },
    { key: 'color' },
    { key: 'discount' },
    { key: 'stock' },
    { key: 'availability' }
  ];
  products.forEach(p => {
    const tr = document.createElement('tr');
    const tdToggle = document.createElement('td');
    tdToggle.className = 'toggle-details';
    tdToggle.innerHTML = 'Down Arrow';
    tdToggle.addEventListener('click', (e) => {
      const detailsRow = e.target.closest('tr').nextElementSibling;
      const isVisible = detailsRow.classList.contains('show');
      detailsRow.classList.toggle('show', !isVisible);
      e.target.textContent = isVisible ? 'Down Arrow' : 'Up Arrow';
    });
    tr.appendChild(tdToggle);

    cols.forEach(col => {
      const td = document.createElement('td');
      td.contentEditable = true;
      td.textContent = p[col.key] != null ? String(p[col.key]) : '';
      td.addEventListener('blur', async (e) => {
        const val = e.target.textContent.trim();
        if (val === (p[col.key] != null ? String(p[col.key]) : '')) return;

        let updateValue = val;
        if (col.key === 'price') {
          if (val !== 'TBA' && isNaN(Number(val))) {
            alert('Price must be a number or "TBA".');
            e.target.textContent = p[col.key] != null ? String(p[col.key]) : '';
            return;
          }
          updateValue = val === 'TBA' ? 'TBA' : Number(val);
        } else if (col.key === 'discount' || col.key === 'stock') {
          if (isNaN(Number(val))) {
            alert(`${col.key.charAt(0).toUpperCase() + col.key.slice(1)} must be a number.`);
            e.target.textContent = p[col.key] != null ? String(p[col.key]) : '';
            return;
          }
          updateValue = Number(val);
        } else if (col.key === 'availability') {
          if (!['Ready', 'Pre Order', 'Upcoming'].includes(val)) {
            alert('Availability must be Ready, Pre Order, or Upcoming.');
            e.target.textContent = p[col.key] != null ? String(p[col.key]) : '';
            return;
          }
        }
        await updateProductField(p.id, col.key, updateValue);
        if (col.key === 'stock' || col.key === 'availability') {
          const cur = (await loadProducts()).find(x => x.id === p.id);
          tr.querySelector('td[data-status="1"]').textContent = computeStatus(cur);
        }
      });
      tr.appendChild(td);
    });

    // Hot Deal Checkbox
    const tdHotDeal = document.createElement('td');
    const hotDealInput = document.createElement('input');
    hotDealInput.type = 'checkbox';
    hotDealInput.checked = !!p.hotDeal;
    hotDealInput.addEventListener('change', async () => {
      await updateProductField(p.id, 'hotDeal', hotDealInput.checked);
    });
    tdHotDeal.appendChild(hotDealInput);
    tr.appendChild(tdHotDeal);

    const tdStatus = document.createElement('td');
    tdStatus.dataset.status = '1';
    tdStatus.textContent = computeStatus(p);
    tr.appendChild(tdStatus);

    const tdActions = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (confirm(`Delete "${p.name}"?`)) await deleteProductById(p.id);
    });
    tdActions.appendChild(del);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);

    const detailsRow = document.createElement('tr');
    detailsRow.className = 'details-row';
    const detailsCell = document.createElement('td');
    detailsCell.colSpan = cols.length + 4;
    detailsCell.className = 'details-content';

    const imagesCell = document.createElement('div');
    imagesCell.contentEditable = true;
    imagesCell.textContent = p.images ? p.images.join(', ') : '';
    imagesCell.addEventListener('blur', async (e) => {
      const val = e.target.textContent.trim();
      if (val === (p.images ? p.images.join(', ') : '')) return;
      const imagesArray = val.split(/,\s*/).map(u => u.trim()).filter(u => u);
      await updateProductField(p.id, 'images', imagesArray);
    });

    const specCell = document.createElement('div');
    specCell.contentEditable = true;
    specCell.textContent = p.description != null ? p.description : '';
    specCell.addEventListener('blur', async (e) => {
      const val = e.target.textContent.trim();
      if (val === (p.description != null ? String(p.description) : '')) return;
      await updateProductField(p.id, 'description', val);
    });

    const detailedDescCell = document.createElement('div');
    detailedDescCell.contentEditable = true;
    detailedDescCell.textContent = p.detailedDescription != null ? p.detailedDescription : '';
    detailedDescCell.addEventListener('blur', async (e) => {
      const val = e.target.textContent.trim();
      if (val === (p.detailedDescription != null ? String(p.detailedDescription) : '')) return;
      await updateProductField(p.id, 'detailedDescription', val);
    });

    const metaTitleCell = document.createElement('div');
    metaTitleCell.contentEditable = true;
    metaTitleCell.textContent = p.metaTitle != null ? p.metaTitle : '';
    metaTitleCell.addEventListener('blur', async (e) => {
      const val = e.target.textContent.trim();
      if (val === (p.metaTitle != null ? String(p.metaTitle) : '')) return;
      await updateProductField(p.id, 'metaTitle', val);
    });

    const metaDescCell = document.createElement('div');
    metaDescCell.contentEditable = true;
    metaDescCell.textContent = p.metaDescription != null ? p.metaDescription : '';
    metaDescCell.addEventListener('blur', async (e) => {
      const val = e.target.textContent.trim();
      if (val === (p.metaDescription != null ? String(p.metaDescription) : '')) return;
      await updateProductField(p.id, 'metaDescription', val);
    });

    detailsCell.innerHTML = `<strong>Image URLs (comma-separated):</strong> `;
    detailsCell.appendChild(imagesCell);
    detailsCell.innerHTML += `<br><strong>Specification:</strong> `;
    detailsCell.appendChild(specCell);
    detailsCell.innerHTML += `<br><strong>Description:</strong> `;
    detailsCell.appendChild(detailedDescCell);
    detailsCell.innerHTML += `<br><strong>Meta Title:</strong> `;
    detailsCell.appendChild(metaTitleCell);
    detailsCell.innerHTML += `<br><strong>Meta Description:</strong> `;
    detailsCell.appendChild(metaDescCell);
    detailsRow.appendChild(detailsCell);
    tbody.appendChild(detailsRow);
  });
}
function computeStatus(p) {
  if (p.availability === 'Upcoming') return 'Upcoming';
  if (p.availability === 'Pre Order') return 'Pre Order';
  return Number(p.stock) > 0 ? 'In Stock' : 'Out of Stock';
}
async function updateProductField(id, field, value) {
  try {
    await updateDoc(doc(db, 'products', id), { [field]: value });
  } catch (err) {
    console.error('Error updating product:', err);
    alert('Error updating product: ' + err.message);
  }
}
async function deleteProductById(id) {
  try {
    await deleteDoc(doc(db, 'products', id));
    renderDataTable();
  } catch (err) {
    console.error('Error deleting product:', err);
    alert('Error deleting product: ' + err.message);
  }
}

// ====== ADMIN: ORDERS TABLE ======
async function renderOrdersTable() {
  const tbody = document.getElementById('orders-body');
  if (!tbody) return;
  const orders = await loadOrders();
  tbody.innerHTML = '';
  orders.forEach(o => {
    const tr = document.createElement('tr');
    const tdToggle = document.createElement('td');
    tdToggle.className = 'toggle-details';
    tdToggle.innerHTML = 'Down Arrow';
    tdToggle.addEventListener('click', (e) => {
      const detailsRow = e.target.closest('tr').nextElementSibling;
      const isVisible = detailsRow.classList.contains('show');
      detailsRow.classList.toggle('show', !isVisible);
      e.target.textContent = isVisible ? 'Down Arrow' : 'Up Arrow';
    });
    tr.appendChild(tdToggle);

    let productName, color, quantity;
    if (o.items && o.items.length > 0) {
      productName = o.items.length > 1 ? `${o.items[0].productName} + ${o.items.length - 1} more` : o.items[0].productName;
      color = o.items.map(i => i.color).filter(c => c).join(', ') || '-';
      quantity = o.items.reduce((s, i) => s + i.quantity, 0);
    } else {
      productName = o.productName;
      color = o.color;
      quantity = o.quantity;
    }

    const tds = [
      new Date(o.timeISO).toLocaleString(),
      productName,
      color,
      quantity,
      '৳' + Number(o.deliveryFee).toFixed(2),
      '৳' + Number(o.paid).toFixed(2),
      '৳' + Number(o.due).toFixed(2),
      o.customerName,
      o.phone,
      o.address,
      o.paymentMethod,
      o.transactionId
    ];
    tds.forEach(v => {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    });

    const tdStatus = document.createElement('td');
    const select = document.createElement('select');
    ['Pending', 'Processing', 'Dispatched', 'Delivered', 'Cancelled'].forEach(opt => {
      const option = document.createElement('option');
      option.value = opt;
      option.text = opt;
      if (o.status === opt) option.selected = true;
      select.appendChild(option);
    });
    select.style.backgroundColor = statusColors[o.status || 'Pending'];
    select.addEventListener('change', async (e) => {
      try {
        const newStatus = e.target.value;
        await updateDoc(doc(db, 'orders', o.id), { status: newStatus });
        select.style.backgroundColor = statusColors[newStatus];
      } catch (err) {
        console.error('Error updating order status:', err);
        alert('Error updating order status: ' + err.message);
      }
    });
    tdStatus.appendChild(select);
    tr.appendChild(tdStatus);
    tbody.appendChild(tr);

    const detailsRow = document.createElement('tr');
    detailsRow.className = 'details-row';
    const detailsCell = document.createElement('td');
    detailsCell.colSpan = 14;
    detailsCell.className = 'details-content';

    if (o.items && o.items.length > 0) {
      detailsCell.innerHTML = '<strong>Items:</strong><br>';
      o.items.forEach(item => {
        const itemDiv = document.createElement('div');
        itemDiv.textContent = `${item.productName} (${item.color || '-'}) x ${item.quantity} @ ৳${Number(item.unitPrice).toFixed(2)} = ৳${(item.unitPrice * item.quantity).toFixed(2)}`;
        detailsCell.appendChild(itemDiv);
      });
    } else {
      const unitPriceCell = document.createElement('div');
      unitPriceCell.textContent = `Unit Price: ৳${Number(o.unitPrice).toFixed(2)}`;
      detailsCell.appendChild(unitPriceCell);
    }

    detailsRow.appendChild(detailsCell);
    tbody.appendChild(detailsRow);
  });
}

// ====== AUTH ======
function logoutAdmin() {
  try {
    signOut(auth);
    console.log('Logged out successfully');
  } catch (err) {
    console.error('Logout error:', err);
    alert('Error logging out: ' + err.message);
  }
}

// ====== MAIN INIT ======
document.addEventListener('DOMContentLoaded', async () => {
  updateCartUI();

  // Cart controls
  document.getElementById('cart-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('cart-slider').classList.add('open');
  });

  document.getElementById('close-cart')?.addEventListener('click', () => {
    document.getElementById('cart-slider').classList.remove('open');
  });

  // ====== CART CHECKOUT MODAL (MULTIPLE PRODUCTS) ======
  document.getElementById('checkout-cart')?.addEventListener('click', async () => {
    const cart = getCart();
    if (cart.length === 0) {
      alert('Your cart is empty!');
      return;
    }

    const products = await loadProducts();
    let subtotal = 0;
    let hasPreOrder = false;

    // Calculate subtotal and check for pre-order
    cart.forEach(item => {
      const p = products.find(pr => pr.id === item.id);
      if (!p) throw new Error('Product not found in cart');
      const unitPrice = Number(p.price) - Number(p.discount || 0);
      subtotal += unitPrice * item.qty;
      if (p.availability === 'Pre Order') hasPreOrder = true;
    });

    // Close cart slider, open cart checkout modal
    document.getElementById('cart-slider').classList.remove('open');
    document.getElementById('cart-checkout-modal').classList.add('show');

    // Display items
    const itemsDiv = document.getElementById('cart-co-items');
    itemsDiv.innerHTML = '<h3>Order Summary</h3>';
    cart.forEach(item => {
      const p = products.find(pr => pr.id === item.id);
      const unitPrice = Number(p.price) - Number(p.discount || 0);
      const line = document.createElement('p');
      line.innerHTML = `<strong>${item.name}</strong> ${item.color ? '(' + item.color + ')' : ''} × ${item.qty}<br>
                        ৳${unitPrice.toFixed(2)} × ${item.qty} = ৳${(unitPrice * item.qty).toFixed(2)}`;
      itemsDiv.appendChild(line);
    });

    // Reset form fields
    document.getElementById('cart-co-payment').value = hasPreOrder ? 'Bkash' : '';
    document.getElementById('cart-co-payment').disabled = hasPreOrder;
    document.getElementById('cart-co-payment-number').value = '';
    document.getElementById('cart-co-txn').value = '';
    document.getElementById('cart-co-name').value = '';
    document.getElementById('cart-co-phone').value = '';
    document.getElementById('cart-co-address').value = '';
    document.getElementById('cart-co-note').textContent = '';
    document.getElementById('cart-co-policy').checked = false;
    document.getElementById('cart-co-pay-now').style.display = 'none';
    document.getElementById('cart-co-due-amount').style.display = 'none';

    // Initial delivery charge
    const initialDelivery = calculateDeliveryFee('');
    document.getElementById('cart-co-delivery').value = `Delivery Charge = ${initialDelivery}`;
    document.getElementById('cart-co-delivery').dataset.fee = initialDelivery;

    // Update totals function — EXACT same logic as single checkout
    function updateCartCheckoutTotals() {
      const address = document.getElementById('cart-co-address').value.trim();
      const deliveryFee = calculateDeliveryFee(address);
      document.getElementById('cart-co-delivery').value = `Delivery Charge = ${deliveryFee}`;
      document.getElementById('cart-co-delivery').dataset.fee = deliveryFee;

      const total = subtotal + deliveryFee;
      document.getElementById('cart-co-total').value = total.toFixed(2);

      const method = document.getElementById('cart-co-payment').value;
      const payNowEl = document.getElementById('cart-co-pay-now');
      const dueEl = document.getElementById('cart-co-due-amount');
      const numberEl = document.getElementById('cart-co-payment-number');
      const txnEl = document.getElementById('cart-co-txn');
      const noteEl = document.getElementById('cart-co-note');

      if (hasPreOrder) {
        // Pre-order: 25% advance (rounded to nearest 5)
        const upfront = Math.round((subtotal * 0.25) / 5) * 5;
        payNowEl.value = upfront.toFixed(2);
        dueEl.value = (total - upfront).toFixed(2);
        numberEl.value = BKASH_NUMBER;
        noteEl.textContent = `Send ৳${upfront} to ${BKASH_NUMBER} and enter transaction ID.`;
        txnEl.required = true;
        payNowEl.style.display = 'block';
        dueEl.style.display = 'block';
      } else if (method === 'Bkash') {
        payNowEl.value = total.toFixed(2);
        dueEl.value = "0.00";
        numberEl.value = BKASH_NUMBER;
        noteEl.textContent = `Send full amount ৳${total.toFixed(2)} to ${BKASH_NUMBER} and provide transaction ID.`;
        txnEl.required = true;
        payNowEl.style.display = 'block';
        dueEl.style.display = 'block';
      } else if (method === 'Cash on Delivery') {
        payNowEl.value = deliveryFee.toFixed(2);
        dueEl.value = subtotal.toFixed(2);
        numberEl.value = COD_NUMBER;
        noteEl.textContent = `Pay delivery charge ৳${deliveryFee}. Remaining on delivery.`;
        txnEl.required = false;
        txnEl.value = '';
        payNowEl.style.display = 'block';
        dueEl.style.display = 'block';
      } else {
        payNowEl.style.display = 'none';
        dueEl.style.display = 'none';
        numberEl.value = '';
        noteEl.textContent = '';
        txnEl.required = false;
      }
    }

    // Attach live updates
    document.getElementById('cart-co-address').removeEventListener('input', updateCartCheckoutTotals);
    document.getElementById('cart-co-payment').removeEventListener('change', updateCartCheckoutTotals);
    document.getElementById('cart-co-address').addEventListener('input', updateCartCheckoutTotals);
    document.getElementById('cart-co-payment').addEventListener('change', updateCartCheckoutTotals);

    // Initial calculation
    updateCartCheckoutTotals();
  });

  // Close cart checkout modal
  document.getElementById('cart-close-modal-btn')?.addEventListener('click', () => {
    document.getElementById('cart-checkout-modal').classList.remove('show');
  });

  // Submit cart order (FIXED: reads before writes)
  document.getElementById('cart-checkout-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.querySelector('#cart-checkout-form button[type="submit"]');
    if (!btn) return;
    btn.disabled = true;

    if (!document.getElementById('cart-co-policy').checked) {
      alert('Please agree to the order policy.');
      btn.disabled = false;
      return;
    }

    const cart = getCart();
    if (cart.length === 0) {
      alert('Cart is empty!');
      btn.disabled = false;
      return;
    }

    const products = await loadProducts();
    const deliveryFee = Number(document.getElementById('cart-co-delivery').dataset.fee);
    let subtotal = 0;
    let hasPreOrder = false;

    const items = cart.map(item => {
  const p = products.find(pr => pr.id === item.id);
  if (!p) throw new Error('Product missing');
  const unitPrice = Number(p.price) - Number(p.discount || 0);

  return {
    productId: item.id,
    productName: item.name,
    color: item.color || '',
    unitPrice,
    quantity: item.qty,
    wasPreOrder: p.availability === 'Pre Order'  // ← NEW LINE
  };
});
    const total = subtotal + deliveryFee;
    const paid = Number(document.getElementById('cart-co-pay-now').value) || 0;
    const due = Number(document.getElementById('cart-co-due-amount').value) || 0;

    const orderData = {
      timeISO: new Date().toISOString(),
      items,
      deliveryFee,
      total,
      paid,
      due,
      customerName: document.getElementById('cart-co-name').value.trim(),
      phone: document.getElementById('cart-co-phone').value.trim(),
      address: document.getElementById('cart-co-address').value.trim(),
      paymentMethod: document.getElementById('cart-co-payment').value,
      paymentNumber: document.getElementById('cart-co-payment-number').value.trim(),
      transactionId: document.getElementById('cart-co-txn').value.trim().toUpperCase(),
      status: 'Pending'
    };

    // Validation
    if (!orderData.customerName || !orderData.phone || !orderData.address || !orderData.paymentMethod) {
      alert('Please fill all required fields.');
      btn.disabled = false;
      return;
    }
    if (orderData.paymentMethod === 'Bkash' && !orderData.transactionId) {
      alert('Transaction ID is required for Bkash payment.');
      btn.disabled = false;
      return;
    }

    try {
      await runTransaction(db, async (transaction) => {
        // === STEP 1: READ ALL products first ===
        const productRefs = items.map(item => doc(db, 'products', item.productId));
        const productSnaps = await Promise.all(productRefs.map(ref => transaction.get(ref)));

        // === STEP 2: Validate stock and schedule updates ===
        for (let i = 0; i < items.length; i++) {
          const snap = productSnaps[i];
          if (!snap.exists()) throw new Error('Product not found');

          const data = snap.data();
          const currentStock = Number(data.stock);
          const item = items[i];

          if (currentStock !== -1 && data.availability !== 'Pre Order' && currentStock < item.quantity) {
            throw new Error(`Not enough stock for ${item.productName}. Only ${currentStock} left.`);
          }

          if (currentStock !== -1 && data.availability !== 'Pre Order') {
            transaction.update(productRefs[i], { stock: currentStock - item.quantity });
          }
        }

        // === STEP 3: Create the order ===
        const newOrderRef = doc(collection(db, 'orders'));
        transaction.set(newOrderRef, orderData);
      });

      alert('Order placed successfully!');
      localStorage.removeItem('cart');
      updateCartUI();
      document.getElementById('cart-checkout-modal').classList.remove('show');
    } catch (err) {
      console.error('Error placing order:', err);
      alert('Error placing order: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });
  const isHome = !!document.getElementById('interest-products');
  const isProducts = !!document.getElementById('product-list');
  const isProduct = !!document.getElementById('product-section');
  const isAdmin = !!document.getElementById('admin-panel');

  if (isHome) await initHomePage();
  if (isProducts) await initProductsPage();
  if (isProduct) await initProductPage();

  const loginPanel = document.getElementById('login-panel');
  const adminPanel = document.getElementById('admin-panel');
  const addForm = document.getElementById('add-product-form');
  if (addForm) addForm.addEventListener('submit', addProduct);

  if (loginPanel && adminPanel) {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        console.log('User logged in:', user.email);
        loginPanel.style.display = 'none';
        adminPanel.style.display = 'block';
        await renderDataTable();
        await renderOrdersTable();
      } else {
        console.log('No user logged in');
        loginPanel.style.display = 'block';
        adminPanel.style.display = 'none';
      }
    });

    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('admin-email').value;
        const pass = document.getElementById('admin-pass').value;
        try {
          await signInWithEmailAndPassword(auth, email, pass);
          console.log('Login successful');
        } catch (err) {
          console.error('Login failed:', err);
          alert('Login failed: ' + err.message);
        }
      });
    }
  }

});














