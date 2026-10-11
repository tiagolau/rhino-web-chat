-- Recuperar opções nativas sem alterar os textos das automações compartilhadas.
alter table faculdades add column menus_crm boolean not null default false;
