#!/usr/bin/env node
//@ts-check

import fs from "fs";
import * as helios from "../helios.js";
import { assert, correctDir, runIfEntryPoint } from "./util.js";

correctDir();

const networkParams = new helios.NetworkParams(JSON.parse(fs.readFileSync("./network-parameters-preview.json").toString()));

async function profile(src, argNames, expected = null) {
    let program = helios.Program.new(src);

    let args = argNames.map(name => program.evalParam(name));

    console.log("ARGS: ", args.map(a => a.toString()));
	
	console.log("IR: ", program.prettyIR(true));
	
	let profileResult = await program.compile(true).profile(args, networkParams);

    console.log(profileResult);

	if (expected != null) {
		assert(profileResult.mem === expected.mem, "unexpected mem budget");
		assert(profileResult.cpu === expected.cpu, "unexpected cpu budget");
		assert(profileResult.size === expected.size, "unexpected size");
	}
}

async function test1() {
	const src = `
	minting multi_nft

	// a single transaction allows multiple minting policies to be used
	// PREC_NFT is empty for the base multi_nft minting policy, 
	// but can be set to the minting policy hash of the base multi_nft minting policy, and so forth, 
	// if you want to mint multiple batches of the tokens (each batch having a different minting policy hash of course)
	const PREC_NFT = #

	enum Redeemer {
		Mint {
			ref: TxOutputId
		}
		Burn
	}

	func main(redeemer: Redeemer, ctx: ScriptContext) -> Bool {
		tx: Tx = ctx.tx;

		mph: MintingPolicyHash = ctx.get_current_minting_policy_hash();

		redeemer.switch { 
			Burn => {
				tx.minted.get_policy(mph).all((_, qty: Int) -> Bool {
					qty == -1
				})
			},
			m: Mint => {
				token_name_suffix: ByteArray = m.ref.serialize().sha3().slice(1, -1);

				// value.get_policy() returns a map of tokens in value
				mint_map: Map[ByteArray]Int = tx.minted.get_policy(mph);

				// check that all minted tokens have the required suffix
				mint_map.all((k: ByteArray, qty: Int) -> Bool {
					qty == 1  && k.ends_with(token_name_suffix)
				}) && (PREC_NFT == # || mint_map == tx.minted.get_policy(MintingPolicyHash::new(PREC_NFT))) && (
					tx.inputs.any((input: TxInput) -> Bool {
						input.output_id == m.ref
					})
				)
			}
		} 
	}

	// const for reference profiling

	const PKH: PubKeyHash = PubKeyHash::new(#01234567890123456789012345678901234567890123456789012345)

	const ADDRESS: Address = Address::new(Credential::new_pubkey(PKH), Option[StakingCredential]::None)

	const IN_VALUE: Value = Value::lovelace(1000000)

	const REF_ID: TxOutputId = TxOutputId::new(TxId::new(#0123456789012345678901234567890123456789012345678901234567891234), 0)

	const MINTED: Value = Value::new(AssetClass::new(MintingPolicyHash::CURRENT, #01 + REF_ID.serialize().sha3().slice(1, -1)), 1)

	const OUT_VALUE: Value = IN_VALUE + MINTED

	const NEW_ID: TxOutputId = TxOutputId::new(TxId::new(#1123456789012345678901234567890123456789012345678901234567891234), 0)

	const REDEEMER = Redeemer::Mint{REF_ID}

	struct Datum {
		a: Int
	}

	const SCRIPT_CONTEXT: ScriptContext = ScriptContext::new_minting(Tx::new(
		[]TxInput{TxInput::new(REF_ID, TxOutput::new(ADDRESS, IN_VALUE, OutputDatum::new_none()))},
		[]TxInput{},
		[]TxOutput{TxOutput::new(ADDRESS, OUT_VALUE, OutputDatum::new_none())},
		Value::lovelace(160000),
		MINTED,
		[]DCert{},
		Map[StakingCredential]Int{},
		TimeRange::ALWAYS,
		[]PubKeyHash{},
		Map[ScriptPurpose]Int{},
		Map[DatumHash]Data{}
	), MintingPolicyHash::CURRENT)`;

	await profile(src, ["REDEEMER", "SCRIPT_CONTEXT"]);
}

async function test2() {
	const src = `
	spending single_datum
	
	struct Datum {
		int: Int
	}
	
	func main(datum: Datum, _, _) -> Bool {
		print(datum.int.show());
		true
	}
	
	const DATUM = Datum{10}
	`

	await profile(src, ["DATUM"]);
}

async function test3() {
	const LIST = `[]Int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}`;

	console.log("profiling list.length");

	await profile(`
	testing list_length

	func main(list: []Int) -> Int {
		list.length
	}

	const LIST = ${LIST}
	`, ["LIST"]);

	console.log("profiling list.drop");

	await profile(`
	testing list_drop

	

	func main(list: []Int) -> []Int {
		list.drop(2)
	}

	const LIST = ${LIST}
	`, ["LIST"]);

	console.log("profiling list.take");

	await profile(`
	testing list_take

	func main(list: []Int) -> []Int {
		list.take(2)
	}

	const LIST = ${LIST}
	`, ["LIST"]);

	console.log("profiling list.take combined with list.length");

	await profile(`
	testing list_length_and_take

	func main(list: []Int) -> []Int {
		n: Int = list.length;

		list.take(n-2)
	}

	const LIST = ${LIST}
	`, ["LIST"]);

	console.log("profiling list.take combined with known list.length");

	await profile(`
	testing list_known_length_and_take

	func main(list: []Int, n: Int) -> []Int {
		list.take(n-2)
	}

	const LIST = ${LIST}

	const N: Int = LIST.length
	`, ["LIST", "N"]);

	console.log("profiling list.drop_end");

	await profile(`
	testing list_drop_end

	func main(list: []Int) -> []Int {
		list.drop_end(2)
	}

	const LIST = ${LIST}
	`, ["LIST"]);

	console.log("profiling list.drop with list.length");

	await profile(`
	testing list_length_and_drop

	func main(list: []Int) -> []Int {
		n: Int = list.length;
		list.drop(n-2)
	}

	const LIST = ${LIST}
	`, ["LIST"]);

	console.log("profiling list.drop with known list.length");

	await profile(`
	testing list_known_length_and_drop

	func main(list: []Int, n: Int) -> []Int {
		
		list.drop(n-2)
	}

	const LIST = ${LIST}

	const N: Int = LIST.length
	`, ["LIST", "N"]);

	console.log("profiling list.take_end");

	await profile(`
	testing list_take_end

	func main(list: []Int) -> []Int {
		list.take_end(2)
	}

	const LIST = ${LIST}
	`, ["LIST"]);
}


export default async function main() {
	await test1();

	await test2();

	await test3();

	// exbudget/size used to be: {mem: 51795n, cpu: 31933326n, size: 367} (when get_policy().all_values(...) was being used). TODO: become that good again
}

runIfEntryPoint(main, "profile.js");
