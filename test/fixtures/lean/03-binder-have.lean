/-
  Fixture 03 —— 带绑定的 have（缺陷 B 回归：丢量词）

  来源：openai/NavierStokesAndEuler 仓库，AnglePrimitiveKernel.lean 第 21–25 行
        （Apache-2.0）https://github.com/openai/NavierStokesAndEuler
  裁剪：为回归测试裁成最小片段，have 行（含换行）保留原文；裁剪后**不保证可编译**。
  期望：签名必须保留绑定前缀，即 `(s : ℝ) : HasDerivAt …`。
        若只剩 `HasDerivAt …`，命题就从 `∀ s, …` 被削弱成 `…`，且**看起来完全正常**。
-/

theorem fixture_binder_have (P : ℝ) (hf : Continuous f) (θ : ℝ) : True := by
  let q := primitive P f
  have hd (s : ℝ) : HasDerivAt (fun r => r • q (θ+r))
      (q (θ+s)+s • f (θ+s)) s := by
    have hq' := (primitive_hasDerivAt P f hf (θ+s)).scomp s ((hasDerivAt_id s).const_add θ)
    simpa only [Function.comp_def, id_eq, one_smul, Pi.smul_def', q, add_comm] using
      (hasDerivAt_id s).smul hq'
  trivial
