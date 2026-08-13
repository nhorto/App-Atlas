'use strict';

const controllers = module.exports;

controllers.login = async function (req, res) {
	res.render('login');
};

controllers.register = async function (req, res) {
	res.render('register');
};

controllers.reset = async function (req, res) {
	res.render('reset', { code: req.params.code });
};

controllers.plain = async function (req, res) {
	res.json({ ok: true });
};

controllers.categories = {
	get: async (req, res) => res.json({ cid: req.params.cid }),
	update: async (req, res) => res.json({ updated: req.params.cid }),
	remove: async (req, res) => res.json({ deleted: req.params.cid }),
};
