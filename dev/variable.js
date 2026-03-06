let cache = localStorage.getItem('last_input') || "x := 12:13;sin[{x}]"

let domInput = document.getElementById('input');
let domOutput = document.getElementById('output');

function subs_expand(value, subs) {
    return value.replaceAll( /\{([^}]+)\}/g, (_, g0) => subs.get(g0))
}

function transform_subs(value) {
    value = value.replaceAll(' ', '');
    let bits = value.split(';')

    let subs = new Map();
    let res = [];

    bits.forEach(bit => {
        let capture = bit.match(/^([^=]+)=(.+)$/);

        if (capture) {
            subs.set(capture[1], subs_expand(capture[2], subs));
        } else {
            res.push(subs_expand(bit, subs));
        }
    })

    return res;
}

domInput.value = cache;
domInput.addEventListener('keyup', (evt) => {
    localStorage.setItem('last_input', domInput.value);
    domOutput.textContent = transform_subs(domInput.value).join(";");
})

