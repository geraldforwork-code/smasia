// Product picker: <input class="product-picker" data-target="#hiddenInputId"> searches /api/products/search
// and writes the chosen product's id into the hidden input.
(function () {
    const list = document.getElementById('product-options');
    const cache = new Map();
    let timer;

    function bind(input) {
        if (input.dataset.bound) return;
        input.dataset.bound = '1';
        input.setAttribute('list', 'product-options');
        input.setAttribute('autocomplete', 'off');
        const target = () => document.querySelector(input.dataset.target) || input.parentElement.querySelector('input[type=hidden]');

        input.addEventListener('input', () => {
            const q = input.value.trim();
            const hit = cache.get(q);
            if (hit) {                       // an option was chosen
                target().value = hit.id;
                input.classList.remove('is-invalid');
                input.dispatchEvent(new CustomEvent('product-picked', { detail: hit, bubbles: true }));
                return;
            }
            target().value = '';
            clearTimeout(timer);
            if (q.length < 2) return;
            timer = setTimeout(async () => {
                const res = await fetch('/api/products/search?q=' + encodeURIComponent(q));
                const items = await res.json();
                list.innerHTML = '';
                for (const p of items) {
                    const label = p.name + (p.barcode ? ' · ' + p.barcode : '') + ' (#' + p.id + ')';
                    cache.set(label, p);
                    const opt = document.createElement('option');
                    opt.value = label;
                    list.appendChild(opt);
                }
            }, 180);
        });
    }

    document.querySelectorAll('.product-picker').forEach(bind);
    new MutationObserver(() => document.querySelectorAll('.product-picker').forEach(bind))
        .observe(document.body, { childList: true, subtree: true });
})();

// Confirm buttons: <button data-confirm="Are you sure?">
document.addEventListener('click', e => {
    const el = e.target.closest('[data-confirm]');
    if (el && !confirm(el.dataset.confirm)) e.preventDefault();
});

// Select-all checkbox: <input type=checkbox data-check-all=".row-check">
document.addEventListener('change', e => {
    const sel = e.target.dataset && e.target.dataset.checkAll;
    if (sel) document.querySelectorAll(sel).forEach(c => { c.checked = e.target.checked; });
});
