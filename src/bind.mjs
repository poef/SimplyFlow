import { throttledEffect, destroy } from './state.mjs'

class SimplyBind {
    constructor(options) {
        this.bindings = new Map()
        const defaultOptions = {
            container: document.body,
            attribute: 'data-bind',
            transformers: [],
            defaultTransformers: {
                field: [defaultFieldTransformer],
                list: [defaultListTransformer],
                map: [defaultMapTransformer]
            }
        }
        if (!options?.root) {
            throw new Error('bind needs at least options.root set')
        }
        this.options = Object.assign({}, defaultOptions, options)

        const attribute      = this.options.attribute
        const bindAttributes = [attribute+'-field',attribute+'-list',attribute+'-map']
        const bindSelector   = `[${attribute}-field],[${attribute}-list],[${attribute}-map]`

        const getBindingAttribute = (el) => {
            const foundAttribute = bindAttributes.find(attr => el.hasAttribute(attr))
            if (!foundAttribute) {
                console.error('No matching attribute found',el)
            }
            return foundAttribute
        }

        // sets up the effect that updates the element if its
        // data binding value changes

        const render = (el) => {
            this.bindings.set(el, throttledEffect(() => {
                const context = {
                    templates: el.querySelectorAll(':scope > template'),
                    attribute: getBindingAttribute(el)
                }
                context.path = this.getBindingPath(el)
                context.value = getValueByPath(this.options.root, context.path)
                context.element = el
                runTransformers(context)
            }, 100))
        }

        // finds and runs applicable transformers
        // creates a stack of transformers, calls the topmost
        // each transformer can opt to call the next or not
        // transformers should return the context object (possibly altered)
        const runTransformers = (context) => {
            let transformers
            switch(context.attribute) {
                case this.options.attribute+'-field':
                    transformers = this.options.defaultTransformers.field || []
                    break
                case this.options.attribute+'-list':
                    transformers = this.options.defaultTransformers.list || []
                    break
                case this.options.attribute+'-map':
                    transformers = this.options.defaultTransformers.map || []
                    break
            }
            if (context.element.dataset.transform) {
                context.element.dataset.transform.split(' ').filter(Boolean).forEach(t => {
                    if (this.options.transformers[t]) {
                        transformers.push(this.options.transformers[t])
                    } else {
                        console.warn('No transformer with name '+t+' configured', {cause:context.element})
                    }
                })
            }
            let next
            for (let transformer of transformers) {
                next = ((next, transformer) => {
                    return (context) => {
                        return transformer.call(this, context, next)
                    }
                })(next, transformer)
            }
            next(context)
        }

        // given a set of elements with data bind attribute
        // this renders each of those elements
        const applyBindings = (bindings) => {
            for (let bindingEl of bindings) {
                render(bindingEl)
            }
        }

        // this handles the mutation observer changes
        // if any element is added, and has a data bind attribute
        // it applies that data binding
        const updateBindings = (changes) => {
            const selector = `[${attribute}-field],[${attribute}-list],[${attribute}-map]`
            for (const change of changes) {
                if (change.type=="childList" && change.addedNodes) {
                    for (let node of change.addedNodes) {
                        if (node instanceof HTMLElement) {
                            let bindings = Array.from(node.querySelectorAll(selector))
                            if (node.matches(selector)) {
                                bindings.unshift(node)
                            }
                            if (bindings.length) {
                                applyBindings(bindings)
                            }
                        }
                    }
                }
            }
        }

        // this responds to elements getting added to the dom
        // and if any have data bind attributes, it applies those bindings
        this.observer = new MutationObserver((changes) => {
            updateBindings(changes)
        })

        this.observer.observe(options.container, {
            subtree: true,
            childList: true
        })

        // this finds elements with data binding attributes and applies those bindings
        // must come after setting up the observer, or included templates
        // won't trigger their own bindings
        const bindings = this.options.container.querySelectorAll(
            '['+this.options.attribute+'-field]'+
            ',['+this.options.attribute+'-list]'+
            ',['+this.options.attribute+'-map]'
        )
        if (bindings.length) {
            applyBindings(bindings)
        }

    }

    /**
     * Finds the first matching template and creates a new DocumentFragment
     * with the correct data bind attributes in it (prepends the current path)
     */
    applyTemplate(context) {
        const path      = context.path
        const templates = context.templates
        const list      = context.list
        const index     = context.index
        const parent    = context.parent
        const value     = list ? list[index] : context.value

        let template = this.findTemplate(templates, value)
        if (!template) {
            let result = new DocumentFragment()
            result.innerHTML = '<!-- no matching template -->'
            return result
        }
        let clone = template.content.cloneNode(true)
        if (!clone.children?.length) {
            return clone
        }
        if (clone.children.length>1) {
            throw new Error('template must contain a single root node', { cause: template })
        }
        const attribute = this.options.attribute
        const attributes = [attribute+'-field',attribute+'-list',attribute+'-map']
        const bindings = clone.querySelectorAll(`[${attribute}-field],[${attribute}-list],[${attribute}-map]`)
        for (let binding of bindings) {
            const attr = attributes.find(attr => binding.hasAttribute(attr))
            const bind = binding.getAttribute(attr)
            if (bind.substring(0, ':root.'.length)==':root.') {
                binding.setAttribute(attr, bind.substring(':root.'.length))
            } else if (bind==':value' && index!=null) {
                binding.setAttribute(attr, path+'.'+index)
            } else if (index!=null) {
                binding.setAttribute(attr, path+'.'+index+'.'+bind)
            } else {
                binding.setAttribute(attr, parent+'.'+bind)
            }
        }
        if (typeof index !== 'undefined') {
            clone.children[0].setAttribute(attribute+'-key',index)
        }
        // keep track of the used template, so if that changes, the 
        // item can be updated
        clone.children[0].$bindTemplate = template
        return clone
    }

    getBindingPath(el) {
        const attributes = [
            this.options.attribute+'-field', 
            this.options.attribute+'-list',
            this.options.attribute+'-map'
        ]
        for (let attr of attributes) {
            if (el.hasAttribute(attr)) {
                return el.getAttribute(attr)
            }
        }
    }

    /**
     * Finds the first template from an array of templates that
     * matches the given value. 
     */
    findTemplate(templates, value) {
        const templateMatches = t => {
            // find the value to match against (e.g. data-bind="foo")
            let path = this.getBindingPath(t)
            let currentItem
            if (path) {
                if (path.substr(0,6)==':root.') {
                    currentItem = getValueByPath(this.options.root, path)
                } else {
                    currentItem = getValueByPath(value, path)
                }
            } else {
                currentItem = value
            }

            // then check the value against pattern, if set (e.g. data-bind-match="bar")
            const strItem = ''+currentItem
            let matches = t.getAttribute(this.options.attribute+'-match')
            if (matches) {
                if (matches===':empty' && !currentItem) {
                    return t
                } else if (matches===':notempty' && currentItem) {
                    return t
                }
                if (strItem.match(matches)) {
                    return t
                }
            }
            if (!matches && currentItem!==null && currentItem!==undefined) {
                //FIXME: this doesn't run templates in lists where list entry is null
                //which messes up the count
                //
                // no data-bind-match is set, so return this template
                return t
            }
        }
        let template = Array.from(templates).find(templateMatches)
        let rel = template?.getAttribute('rel')
        if (rel) {
            let replacement = document.querySelector('template#'+rel)
            if (!replacement) {
                throw new Error('Could not find template with id '+rel)
            }
            template = replacement
        }
        return template
    }

    destroy() {
        this.bindings.forEach(binding => {
            destroy(binding)
        })
        this.bindings = new Map()
        this.observer.disconnect()
    }

}

/**
 * Returns a new instance of SimplyBind. This is the normal start
 * of a data bind flow
 */
export function bind(options)
{
    return new SimplyBind(options)
}

/**
 * Returns true if a matches b, either by having the
 * same string value, or matching string :empty against a falsy value
 */
export function matchValue(a,b) {
    if (a==':empty' && !b) {
        return true
    }
    if (b==':empty' && !a) {
        return true
    }
    if (''+a == ''+b) {
        return true
    }
    return false
}

/**
 * Returns the value by walking the given path
 * as a json pointer, starting at root
 * if you have a property with a '.' in its name
 * urlencode the '.', e.g: %46
 */
export function getValueByPath(root, path)
{
    let parts = path.split('.');
    let curr = root;
    let part, prevPart;
    while (parts.length && curr) {
        part = parts.shift()
        if (part==':key') {
            return prevPart
        } else if (part==':value') {
            return curr
        } else if (part==':root') {
            curr = root
        } else {
            part = decodeURIComponent(part)
            curr = curr[part];
            prevPart = part
        }
    }
    return curr
}

/**
 * Default transformer for data binding
 * Will be used unless overriden in the SimplyBind options parameter
 */
export function defaultFieldTransformer(context) {
    const el             = context.element
    const templates      = context.templates
    const templatesCount = templates.length 
    const path           = context.path
    const value          = context.value
    const attribute      = this.options.attribute

    if (templates?.length) {
        transformLiteralByTemplates.call(this, context)
    } else if (el.tagName=='INPUT') {
        transformInput.call(this, context)
    } else if (el.tagName=='BUTTON') {
        transformButton.call(this, context)
    } else if (el.tagName=='SELECT') {
        transformSelect.call(this, context)
    } else if (el.tagName=='A') {
        transformAnchor.call(this, context)
    } else {
        transformElement.call(this, context)
    }
    return context
}

export function defaultListTransformer(context) {
    const el             = context.element
    const templates      = context.templates
    const templatesCount = templates.length 
    const path           = context.path
    const value          = context.value
    const attribute      = this.options.attribute

    if (!Array.isArray(value)) {
        console.error('Value is not an array.', el, value)
    } else if (!templates?.length) {
        console.error('No templates found in', el)
    } else {
        transformArrayByTemplates.call(this, context)
    }
    return context
}

export function defaultMapTransformer(context) {
    const el             = context.element
    const templates      = context.templates
    const templatesCount = templates.length 
    const path           = context.path
    const value          = context.value
    const attribute      = this.options.attribute

    if (typeof value != 'object') {
        console.error('Value is not an object.', el, value)
    } else if (!templates?.length) {
        console.error('No templates found in', el)
    } else {
        transformObjectByTemplates.call(this, context)
    }
    return context
}


/**
 * Renders an array value by applying templates for each entry
 * Replaces or removes existing DOM children if needed
 * Reuses (doesn't touch) DOM children if template doesn't change
 * FIXME: this doesn't handle situations where there is no matching template
 * this messes up self healing. check transformObjectByTemplates for a better implementation
 */
export function transformArrayByTemplates(context) {
    const el             = context.element
    const templates      = context.templates
    const templatesCount = templates.length 
    const path           = context.path
    const value          = context.value
    const attribute      = this.options.attribute

    let items = el.querySelectorAll(':scope > ['+attribute+'-key]')
    // do single merge strategy for now, in future calculate optimal merge strategy from a number
    // now just do a delete if a key <= last key, insert if a key >= last key
    let lastKey = 0
    let skipped = 0
    context.list  = value
    for (let item of items) {
        let currentKey = parseInt(item.getAttribute(attribute+'-key'))
        if (currentKey>lastKey) {
            // insert before
            context.index = lastKey
            el.insertBefore(this.applyTemplate(context), item)
        } else if (currentKey<lastKey) {
            // remove this
            item.remove()
        } else {
            // check that all data-bind params start with current json path or ':root', otherwise replaceChild
            let bindings = Array.from(item.querySelectorAll(`[${attribute}]`))
            if (item.matches(`[${attribute}]`)) {
                bindings.unshift(item)
            }
            let needsReplacement = bindings.find(b => {
                let databind = b.getAttribute(attribute)
                return (databind.substr(0,5)!==':root' 
                    && databind.substr(0, path.length)!==path)
            })
            if (!needsReplacement) {
                if (item.$bindTemplate) {
                    let newTemplate = this.findTemplate(templates, value[lastKey])
                    if (newTemplate != item.$bindTemplate){
                        needsReplacement = true
                        if (!newTemplate) {
                            skipped++
                        }
                    }
                }
            }
            if (needsReplacement) {
                context.index = lastKey
                el.replaceChild(this.applyTemplate(context), item)
            }
        }
        lastKey++
        if (lastKey>=value.length) {
            break
        }
    }
    items = el.querySelectorAll(':scope > ['+attribute+'-key]')
    let length = items.length + skipped
    if (length > value.length) {
        while (length > value.length) {
            let child = el.querySelectorAll(':scope > :not(template)')?.[length-1]
            child?.remove()
            length--
        }
    } else if (length < value.length ) {
        while (length < value.length) {
            context.index = length
            el.appendChild(this.applyTemplate(context))
            length++
        }
    }
}

/**
 * Renders an object value by applying templates for each entry (Object.entries)
 * Replaces,moves or removes existing DOM children if needed
 * Reuses (doesn't touch) DOM children if template doesn't change
 */
export function transformObjectByTemplates(context) {
    const el             = context.element
    const templates      = context.templates
    const templatesCount = templates.length 
    const path           = context.path
    const value          = context.value
    const attribute      = this.options.attribute
    context.list = value

    let items = Array.from(el.querySelectorAll(':scope > ['+attribute+'-key]'))
    for (let key in context.list) {
        context.index = key
        let item = items.shift()
        if (!item) { // more properties than rendered items
            let clone = this.applyTemplate(context)
            if (clone.firstElementChild) {
                el.appendChild(clone)
            }
            continue
        }
        if (item.getAttribute[attribute+'-key']!=key) { 
            // next item doesn't match key
            items.unshift(item) // put item back for next cycle
            let outOfOrderItem = el.querySelector(':scope > ['+attribute+'-key="'+key+'"]') //FIXME: escape key
            if (!outOfOrderItem) {
                let clone = this.applyTemplate(context)
                if (clone.firstElementChild) {
                    el.insertBefore(clone, item)
                }
                continue // new template doesn't need replacement, so continue 
            } else {
                el.insertBefore(outOfOrderItem, item)
                item = outOfOrderItem // check needsreplacement next
                items = items.filter(i => i!=outOfOrderItem)
            }
        }
        let newTemplate = this.findTemplate(templates, value[key])
        if (newTemplate != item.$bindTemplate){
            let clone = this.applyTemplate(context)
            el.replaceChild(clone, item)
        }
    }
    // clean up remaining items
    while (items.length) {
        let item = items.shift()
        item.remove()
    }
}

function getParentPath(el, attribute) {
    const parentEl  = el.parentElement?.closest(`[${attribute}-list],[${attribute}-map]`)
    if (!parentEl) {
        return ':root'
    }
    if (parentEl.hasAttribute(`${attribute}-list`)) {
        return parentEl.getAttribute(`${attribute}-list`)
    }
    return parentEl.getAttribute(`${attribute}-map`)
}

/**
 * transforms the contents of an html element by rendering
 * a matching template, once.
 * data-bind attributes inside the template use the same
 * parent path as this html element uses
 */
export function transformLiteralByTemplates(context) {
    const el             = context.element
    const templates      = context.templates
    const value          = context.value
    const attribute      = this.options.attribute

    const rendered = el.querySelector(':scope > :not(template)')
    const template = this.findTemplate(templates, value)

    context.parent = getParentPath(el, attribute)
    if (rendered) {
        if (template) {
            if (rendered?.$bindTemplate != template) {
                const clone = this.applyTemplate(context)
                el.replaceChild(clone, rendered)
            }
        } else {
            el.removeChild(rendered)
        }
    } else if (template) {
        const clone = this.applyTemplate(context)
        el.appendChild(clone)
    }
}

/**
 * transforms a single input type
 * for radio/checkbox inputs it only sets the checked attribute to true/false
 * if the value attribute matches the current value
 * for other inputs the value attribute is updated
 * FIXME: handle radio/checkboxes in separate transformer
 */
export function transformInput(context) {
    const el    = context.element
    const value = context.value

    if (el.type=='checkbox' || el.type=='radio') {
        if (matchValue(el.value, value)) {
            el.checked = true
        } else {
            el.checked = false
        }
    } else if (!matchValue(el.value, value)) {
        el.value = ''+value
    }
}

/**
 * Sets the value of the button, doesn't touch the innerHTML
 */
export function transformButton(context) {
    const el    = context.element
    const value = context.value

    if (!matchValue(el.value,value)) {
        el.value = ''+value
    }
}

/**
 * Sets the selected attribute of select options
 */
export function transformSelect(context) {
    const el    = context.element
    const value = context.value

    if (el.multiple) {
        if (Array.isArray(value)) {
            for (let option of el.options) {
                if (value.indexOf(option.value)===false) {
                    option.selected = false
                } else {
                    option.selected = true
                }
            }
        }
    } else {
        let option = el.options.find(o => matchValue(o.value,value))
        if (option) {
            option.selected = true
        }
    }
}

/**
 * Sets the innerHTML and href attribute of an anchor
 * TODO: support target, title, etc. attributes
 */
export function transformAnchor(context) {
    const el    = context.element
    const value = context.value

    if (value?.innerHTML && !matchValue(el.innerHTML, value.innerHTML)) {
        el.innerHTML = ''+value.innerHTML
    }
    if (value?.href && !matchValue(el.href,value.href)) {
        el.href = ''+value.href
    }    
}

/**
 * sets the innerHTML of any HTML element
 */
export function transformElement(context) {
    const el    = context.element
    const value = context.value

    if (!matchValue(el.innerHTML, value)) {
        if (typeof value=='undefined' || value==null) {
            el.innerHTML = ''
        } else {
            el.innerHTML = ''+value
        }
    }
}