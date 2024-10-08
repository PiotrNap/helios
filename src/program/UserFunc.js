import { $, SourceMappedString, compile as compileIR } from "@helios-lang/ir"
import { UplcProgramV2 } from "@helios-lang/uplc"
import { ToIRContext, genExtraDefs } from "../codegen/index.js"
import { FuncStatement } from "../statements/index.js"
import { ModuleCollection } from "./ModuleCollection.js"
import { IR_PARSE_OPTIONS } from "../parse/index.js"
import { FuncArg } from "../expressions/FuncArg.js"
import { expectSome } from "@helios-lang/type-utils"

/**
 * @typedef {import("../typecheck/index.js").ScriptTypes} ScriptTypes
 * @typedef {import("./EntryPoint.js").EntryPoint} EntryPoint
 */

export class UserFunc {
    /**
     * @readonly
     * @type {ModuleCollection}
     */
    modules

    /**
     * @readonly
     * @type {string}
     */
    name

    /**
     * @param {ModuleCollection} modules
     * @param {string} name - member functions have a `Type::` prefix
     */
    constructor(modules, name) {
        this.modules = modules
        this.name = name
    }

    /**
     * @type {FuncStatement}
     */
    get mainFunc() {
        const lastModule = this.modules.lastModule

        const nameParts = this.name.split("::")

        for (let s of lastModule.statements) {
            if (s instanceof FuncStatement && s.name.value == this.name) {
                return s
            } else if (s.name.value == nameParts[0]) {
                for (let ss of s.statements) {
                    if (
                        ss instanceof FuncStatement &&
                        ss.name.value == nameParts[1]
                    ) {
                        return ss
                    }
                }

                throw new Error(`${this.name} undefined`)
            }
        }

        throw new Error(`${this.name} undefined`)
    }

    /**
     * @param {{
     *   optimize: boolean
     *   validatorTypes: ScriptTypes
     *   validatorIndices?: Record<string, number>
     *   hashDependencies: Record<string, string>
     * }} props
     * @returns {UplcProgramV2}
     */
    compile(props) {
        const { ir } = this.toIR({
            validatorTypes: props.validatorTypes,
            optimize: props.optimize,
            hashDependencies: props.hashDependencies,
            validatorIndices: props.validatorIndices
        })

        const uplc = compileIR(ir, {
            optimize: props.optimize,
            parseOptions: IR_PARSE_OPTIONS
        })

        return uplc
    }

    /**
     * @param {{
     *   validatorTypes: ScriptTypes
     *   validatorIndices?: Record<string, number>
     *   optimize?: boolean
     *   hashDependencies?: Record<string, string>
     *   currentScriptValue?: string
     * }} props
     * @returns {{
     *   ir: SourceMappedString
     *   requiresScriptContext: boolean
     *   requiresCurrentScript: boolean
     * }}
     */
    toIR(props) {
        const ctx = new ToIRContext({
            optimize: props.optimize ?? false,
            isTestnet: false,
            makeParamsSubstitutable: false
        })

        const extra = genExtraDefs({
            dependsOnOwnHash: false,
            makeParamsSubstitutable: false,
            hashDependencies:
                props.hashDependencies ??
                Object.fromEntries(
                    Array.from(Object.keys(props.validatorTypes)).map(
                        (name) => [name, "#"]
                    )
                ),
            name: this.name,
            validatorTypes: props.validatorTypes,
            validatorIndices: props.validatorIndices,
            currentScriptValue: props.currentScriptValue ?? "__CURRENT_SCRIPT"
        })

        /**
         * @param {FuncArg[]} args
         * @returns {string}
         */
        const argsToString = (args) => {
            return args
                .map((arg) => {
                    const name = arg.name.value
                    const typePath = expectSome(arg.type.asDataType).path

                    if (arg.isIgnored()) {
                        return "()"
                    } else if (arg.isOptional) {
                        // assume outer arg is wrapped in data-option
                        const cond = `__helios__option__is_some(${name})`
                        const value = `__core__ifThenElse(
                        ${cond}, 
                        () -> {
                            __helios__option[${typePath}]__some__some(${name})
                        }, 
                        () -> {()}
                    )()`

                        return `${cond}, ${value}`
                    } else {
                        return `${typePath}__from_data(${name})`
                    }
                })
                .join(", ")
        }

        const fn = this.mainFunc
        const isMethod = fn.funcExpr.isMethod()
        let ir = isMethod
            ? $`${fn.path}(${argsToString(fn.args.slice(0, 1))})(${argsToString(fn.args.slice(1))})`
            : $`${fn.path}(${argsToString(fn.args)})`

        const retTypePath = expectSome(fn.retType.asDataType).path
        ir = $`${retTypePath}____to_data(${ir})`

        const defs = this.modules.fetchDefinitions(
            ctx,
            ir,
            (s, isImport) =>
                !isImport && s.name.value == this.name.split("::")[0],
            extra
        )

        ir = this.modules.wrap(ctx, ir, defs)

        const requiresCurrentScript = ir.includes(
            "__helios__scriptcontext__current_script"
        )
        const requiresScriptContext = ir.includes(
            "__helios__scriptcontext__data"
        )

        const outerArgNames = fn.args
            .filter((arg) => !arg.isIgnored())
            .map((arg) => arg.name.value)
            .concat(requiresScriptContext ? ["__CONTEXT"] : [])
            .concat(requiresCurrentScript ? ["__CURRENT_SCRIPT"] : [])

        ir = $`(${outerArgNames.join(", ")}) -> {
            ${ir}
        }`

        return {
            ir: ir,
            requiresCurrentScript: requiresCurrentScript,
            requiresScriptContext: requiresScriptContext
        }
    }
}
